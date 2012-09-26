/*
 * Buffer management functions.
 *
 * Copyright 2000-2010 Willy Tarreau <w@1wt.eu>
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version
 * 2 of the License, or (at your option) any later version.
 *
 */

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include <common/config.h>
#include <common/memory.h>
#include <proto/buffers.h>
#include <types/global.h>

struct pool_head *pool2_buffer;


/* perform minimal intializations, report 0 in case of error, 1 if OK. */
int init_buffer()
{
	pool2_buffer = create_pool("buffer", sizeof(struct buffer) + global.tune.bufsize, MEM_F_SHARED);
	return pool2_buffer != NULL;
}

/* Schedule up to <bytes> more bytes to be forwarded by the buffer without notifying
 * the task. Any pending data in the buffer is scheduled to be sent as well,
 * in the limit of the number of bytes to forward. This must be the only method
 * to use to schedule bytes to be sent. If the requested number is too large, it
 * is automatically adjusted. The number of bytes taken into account is returned.
 * Directly touching ->to_forward will cause lockups when send_max goes down to
 * zero if nobody is ready to push the remaining data.
 */
unsigned long long buffer_forward(struct buffer *buf, unsigned long long bytes)
{
	unsigned int data_left;
	unsigned int new_forward;

	if (!bytes)
		return 0;
	data_left = buf->l - buf->send_max;
	if (bytes <= (unsigned long long)data_left) {
		buf->send_max += bytes;
		buf->flags &= ~BF_OUT_EMPTY;
		return bytes;
	}

	buf->send_max += data_left;
	if (buf->send_max)
		buf->flags &= ~BF_OUT_EMPTY;

	if (buf->l < buffer_max_len(buf))
		buf->flags &= ~BF_FULL;
	else
		buf->flags |= BF_FULL;

	if (likely(bytes == BUF_INFINITE_FORWARD)) {
		buf->to_forward = bytes;
		return bytes;
	}

	/* Note: the case below is the only case where we may return
	 * a byte count that does not fit into a 32-bit number.
	 */
	if (likely(buf->to_forward == BUF_INFINITE_FORWARD))
		return bytes;

	new_forward = buf->to_forward + bytes - data_left;
	bytes = data_left; /* at least those bytes were scheduled */

	if (new_forward <= buf->to_forward) {
		/* integer overflow detected, let's assume no more than 2G at once */
		new_forward = MID_RANGE(new_forward);
	}

	if (new_forward > buf->to_forward) {
		bytes += new_forward - buf->to_forward;
		buf->to_forward = new_forward;
	}
	return bytes;
}

/* writes <len> bytes from message <msg> to buffer <buf>. Returns -1 in case of
 * success, -2 if the message is larger than the buffer size, or the number of
 * bytes available otherwise. The send limit is automatically adjusted with the
 * amount of data written. FIXME-20060521: handle unaligned data.
 */
int buffer_write(struct buffer *buf, const char *msg, int len)
{
	int max;

	if (len == 0)
		return -1;

	if (len > buf->size) {
		/* we can't write this chunk and will never be able to, because
		 * it is larger than the buffer. This must be reported as an
		 * error. Then we return -2 so that writers that don't care can
		 * ignore it and go on, and others can check for this value.
		 */
		return -2;
	}

	max = buffer_realign(buf);

	if (len > max)
		return max;

	memcpy(buf->r, msg, len);
	buf->l += len;
	buf->send_max += len;
	buf->r += len;
	buf->total += len;
	if (buf->r == buf->data + buf->size)
		buf->r = buf->data;

	buf->flags &= ~(BF_OUT_EMPTY|BF_FULL);
	if (buf->l >= buffer_max_len(buf))
		buf->flags |= BF_FULL;

	return -1;
}

/* Try to write string <str> into buffer <buf> after length controls. This
 * is the equivalent of buffer_write() except that to_forward and send_max
 * are updated and that max_len is respected. Returns -1 in case of success,
 * -2 if it is larger than the buffer size, or the number of bytes available
 * otherwise. The send limit is automatically adjusted with the amount of data
 * written.
 */
int buffer_feed2(struct buffer *buf, const char *str, int len)
{
	int max;

	if (len == 0)
		return -1;

	if (len > buffer_max_len(buf)) {
		/* we can't write this chunk and will never be able to, because
		 * it is larger than the buffer's current max size.
		 */
		return -2;
	}

	max = buffer_contig_space(buf);

	if (len > max)
		return max;

	memcpy(buf->r, str, len);
	buf->l += len;
	buf->r += len;
	buf->total += len;
	if (buf->to_forward) {
		unsigned long fwd = len;
		if (buf->to_forward != BUF_INFINITE_FORWARD) {
			if (fwd > buf->to_forward)
				fwd = buf->to_forward;
			buf->to_forward -= fwd;
		}
		buf->send_max += fwd;
		buf->flags &= ~BF_OUT_EMPTY;
	}

	if (buf->r == buf->data + buf->size)
		buf->r = buf->data;

	buf->flags &= ~BF_FULL;
	if (buf->l >= buffer_max_len(buf))
		buf->flags |= BF_FULL;

	/* notify that some data was read from the SI into the buffer */
	buf->flags |= BF_READ_PARTIAL;
	return -1;
}

/* Get one text line out of a buffer from a stream interface.
 * Return values :
 *   >0 : number of bytes read. Includes the \n if present before len or end.
 *   =0 : no '\n' before end found. <buf> is undefined.
 *   <0 : no more bytes readable + shutdown set.
 * The buffer status is not changed. The caller must call buffer_skip() to
 * update it. The '\n' is waited for as long as neither the buffer nor the
 * output are full. If either of them is full, the string may be returned
 * as is, without the '\n'.
 */
int buffer_si_peekline(struct buffer *buf, char *str, int len)
{
	int ret, max;
	char *p;

	ret = 0;
	max = len;
	if (!buf->send_max) {
		if (buf->flags & (BF_SHUTW|BF_SHUTW_NOW))
			ret = -1;
		goto out;
	}

	p = buf->w;

	if (max > buf->send_max) {
		max = buf->send_max;
		str[max-1] = 0;
	}
	while (max) {
		*str++ = *p;
		ret++;
		max--;

		if (*p == '\n')
			break;
		p++;
		if (p == buf->data + buf->size)
			p = buf->data;
	}
	if (ret > 0 && ret < len && ret < buf->send_max &&
	    *(str-1) != '\n' &&
	    !(buf->flags & (BF_SHUTW|BF_SHUTW_NOW)))
		ret = 0;
 out:
	if (max)
		*str = 0;
	return ret;
}

/*
 * this function writes the string <str> at position <pos> which must be in buffer <b>,
 * and moves <end> just after the end of <str>.
 * <b>'s parameters (l, r, lr) are recomputed to be valid after the shift.
 * the shift value (positive or negative) is returned.
 * If there's no space left, the move is not done.
 * The function does not adjust ->send_max nor BF_OUT_EMPTY because it does not
 * make sense to use it on data scheduled to be sent.
 *
 */
int buffer_replace(struct buffer *b, char *pos, char *end, const char *str)
{
	int delta;
	int len;

	len = strlen(str);
	delta = len - (end - pos);

	if (delta + b->r >= b->data + b->size)
		return 0;  /* no space left */

	if (delta + b->r > b->w && b->w >= b->r && b->l)
		return 0;  /* no space left before wrapping data */

	/* first, protect the end of the buffer */
	memmove(end + delta, end, b->r - end);

	/* now, copy str over pos */
	memcpy(pos, str,len);

	/* we only move data after the displaced zone */
	if (b->r  > pos) b->r  += delta;
	if (b->lr > pos) b->lr += delta;
	b->l += delta;

	b->flags &= ~BF_FULL;
	if (b->l == 0)
		b->r = b->w = b->lr = b->data;
	if (b->l >= buffer_max_len(b))
		b->flags |= BF_FULL;

	return delta;
}

/*
 * same except that the string length is given, which allows str to be NULL if
 * len is 0. The send limit is *not* adjusted.
 */
int buffer_replace2(struct buffer *b, char *pos, char *end, const char *str, int len)
{
	int delta;

	delta = len - (end - pos);

	if (delta + b->r >= b->data + b->size)
		return 0;  /* no space left */

	if (delta + b->r > b->w && b->w >= b->r && b->l)
		return 0;  /* no space left before wrapping data */

	/* first, protect the end of the buffer */
	memmove(end + delta, end, b->r - end);

	/* now, copy str over pos */
	if (len)
		memcpy(pos, str, len);

	/* we only move data after the displaced zone */
	if (b->r  > pos) b->r  += delta;
	if (b->lr > pos) b->lr += delta;
	b->l += delta;

	b->flags &= ~BF_FULL;
	if (b->l == 0)
		b->r = b->w = b->lr = b->data;
	if (b->l >= buffer_max_len(b))
		b->flags |= BF_FULL;

	return delta;
}


/*
 * Inserts <str> followed by "\r\n" at position <pos> in buffer <b>. The <len>
 * argument informs about the length of string <str> so that we don't have to
 * measure it. It does not include the "\r\n". If <str> is NULL, then the buffer
 * is only opened for len+2 bytes but nothing is copied in. It may be useful in
 * some circumstances. The send limit is *not* adjusted.
 *
 * The number of bytes added is returned on success. 0 is returned on failure.
 */
int buffer_insert_line2(struct buffer *b, char *pos, const char *str, int len)
{
	int delta;

	delta = len + 2;

	if (delta + b->r >= b->data + b->size)
		return 0;  /* no space left */

	/* first, protect the end of the buffer */
	memmove(pos + delta, pos, b->r - pos);

	/* now, copy str over pos */
	if (len && str) {
		memcpy(pos, str, len);
		pos[len] = '\r';
		pos[len + 1] = '\n';
	}

	/* we only move data after the displaced zone */
	if (b->r  > pos) b->r  += delta;
	if (b->lr > pos) b->lr += delta;
	b->l += delta;

	b->flags &= ~BF_FULL;
	if (b->l >= buffer_max_len(b))
		b->flags |= BF_FULL;

	return delta;
}


/* Realigns a possibly non-contiguous buffer by bouncing bytes from source to
 * destination. It does not use any intermediate buffer and does the move in
 * place, though it will be slower than a simple memmove() on contiguous data,
 * so it's desirable to use it only on non-contiguous buffers. No pointers are
 * changed, the caller is responsible for that.
 */
void buffer_bounce_realign(struct buffer *buf)
{
	int advance, to_move;
	char *from, *to;

	advance = buf->data + buf->size - buf->w;
	if (!advance)
		return;

	from = buf->w;
	to_move = buf->l;
	while (to_move) {
		char last, save;

		last = *from;
		to = from + advance;
		if (to >= buf->data + buf->size)
			to -= buf->size;

		while (1) {
			save = *to;
			*to  = last;
			last = save;
			to_move--;
			if (!to_move)
				break;

			/* check if we went back home after rotating a number of bytes */
			if (to == from)
				break;

			/* if we ended up in the empty area, let's walk to next place. The
			 * empty area is either between buf->r and from or before from or
			 * after buf->r.
			 */
			if (from > buf->r) {
				if (to >= buf->r && to < from)
					break;
			} else if (from < buf->r) {
				if (to < from || to >= buf->r)
					break;
			}

			/* we have overwritten a byte of the original set, let's move it */
			to += advance;
			if (to >= buf->data + buf->size)
				to -= buf->size;
		}

		from++;
		if (from >= buf->data + buf->size)
			from -= buf->size;
	}
}


/*
 * Does an snprintf() at the end of chunk <chk>, respecting the limit of
 * at most chk->size chars. If the chk->len is over, nothing is added. Returns
 * the new chunk size.
 */
int chunk_printf(struct chunk *chk, const char *fmt, ...)
{
	va_list argp;
	int ret;

	if (!chk->str || !chk->size)
		return 0;

	va_start(argp, fmt);
	ret = vsnprintf(chk->str + chk->len, chk->size - chk->len, fmt, argp);
	if (ret >= chk->size - chk->len)
		/* do not copy anything in case of truncation */
		chk->str[chk->len] = 0;
	else
		chk->len += ret;
	va_end(argp);
	return chk->len;
}

/*
 * Encode chunk <src> into chunk <dst>, respecting the limit of at most
 * chk->size chars. Replace non-printable or special chracters with "&#%d;".
 * If the chk->len is over, nothing is added. Returns the new chunk size.
 */
int chunk_htmlencode(struct chunk *dst, struct chunk *src) {

	int i, l;
	int olen, free;
	char c;

	olen = dst->len;

	for (i = 0; i < src->len; i++) {
		free = dst->size - dst->len;

		if (!free) {
			dst->len = olen;
			return dst->len;
		}

		c = src->str[i];

		if (!isascii(c) || !isprint((unsigned char)c) || c == '&' || c == '"' || c == '\'' || c == '<' || c == '>') {
			l = snprintf(dst->str + dst->len, free, "&#%u;", (unsigned char)c);

			if (free < l) {
				dst->len = olen;
				return dst->len;
			}

			dst->len += l;
		} else {
			dst->str[dst->len] = c;
			dst->len++;
		}
	}

	return dst->len;
}

/*
 * Encode chunk <src> into chunk <dst>, respecting the limit of at most
 * chk->size chars. Replace non-printable or char passed in qc with "<%02X>".
 * If the chk->len is over, nothing is added. Returns the new chunk size.
 */
int chunk_asciiencode(struct chunk *dst, struct chunk *src, char qc) {
	int i, l;
	int olen, free;
	char c;

	olen = dst->len;

	for (i = 0; i < src->len; i++) {
		free = dst->size - dst->len;

		if (!free) {
			dst->len = olen;
			return dst->len;
		}

		c = src->str[i];

		if (!isascii(c) || !isprint((unsigned char)c) || c == '<' || c == '>' || c == qc) {
			l = snprintf(dst->str + dst->len, free, "<%02X>", (unsigned char)c);

			if (free < l) {
				dst->len = olen;
				return dst->len;
			}

			dst->len += l;
		} else {
			dst->str[dst->len] = c;
			dst->len++;
		}
	}

	return dst->len;
}

/*
 * Dumps part or all of a buffer.
 */
void buffer_dump(FILE *o, struct buffer *b, int from, int to)
{
	fprintf(o, "Dumping buffer %p\n", b);
	fprintf(o, "  data=%p l=%d r=%p w=%p lr=%p\n",
		b->data, b->l, b->r, b->w, b->lr);

	if (!to || to > b->l)
		to = b->l;

	fprintf(o, "Dumping contents from byte %d to byte %d\n", from, to);
	for (; from < to; from++) {
		if ((from & 15) == 0)
			fprintf(o, "  %04x: ", from);
		fprintf(o, "%02x ", b->data[from]);
		if ((from & 15) == 7)
			fprintf(o, "- ");
		else if (((from & 15) == 15) && (from != to-1))
			fprintf(o, "\n");
	}
	fprintf(o, "\n--\n");
}


/*
 * Local variables:
 *  c-indent-level: 8
 *  c-basic-offset: 8
 * End:
 */
