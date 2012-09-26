/*
 * include/common/standard.h
 * This files contains some general purpose functions and macros.
 *
 * Copyright (C) 2000-2010 Willy Tarreau - w@1wt.eu
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation, version 2.1
 * exclusively.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 */

#ifndef _COMMON_STANDARD_H
#define _COMMON_STANDARD_H

#include <limits.h>
#include <string.h>
#include <time.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <common/config.h>
#include <eb32tree.h>
#include <proto/fd.h>

/****** string-specific macros and functions ******/
/* if a > max, then bound <a> to <max>. The macro returns the new <a> */
#define UBOUND(a, max)	({ typeof(a) b = (max); if ((a) > b) (a) = b; (a); })

/* if a < min, then bound <a> to <min>. The macro returns the new <a> */
#define LBOUND(a, min)	({ typeof(a) b = (min); if ((a) < b) (a) = b; (a); })

/* returns 1 only if only zero or one bit is set in X, which means that X is a
 * power of 2, and 0 otherwise */
#define POWEROF2(x) (((x) & ((x)-1)) == 0)

/*
 * copies at most <size-1> chars from <src> to <dst>. Last char is always
 * set to 0, unless <size> is 0. The number of chars copied is returned
 * (excluding the terminating zero).
 * This code has been optimized for size and speed : on x86, it's 45 bytes
 * long, uses only registers, and consumes only 4 cycles per char.
 */
extern int strlcpy2(char *dst, const char *src, int size);

/*
 * This function simply returns a locally allocated string containing
 * the ascii representation for number 'n' in decimal.
 */
extern char itoa_str[][171];
extern char *ultoa_r(unsigned long n, char *buffer, int size);
extern const char *ulltoh_r(unsigned long long n, char *buffer, int size);
static inline const char *ultoa(unsigned long n)
{
	return ultoa_r(n, itoa_str[0], sizeof(itoa_str[0]));
}

/* Fast macros to convert up to 10 different parameters inside a same call of
 * expression.
 */
#define U2A0(n) ({ ultoa_r((n), itoa_str[0], sizeof(itoa_str[0])); })
#define U2A1(n) ({ ultoa_r((n), itoa_str[1], sizeof(itoa_str[1])); })
#define U2A2(n) ({ ultoa_r((n), itoa_str[2], sizeof(itoa_str[2])); })
#define U2A3(n) ({ ultoa_r((n), itoa_str[3], sizeof(itoa_str[3])); })
#define U2A4(n) ({ ultoa_r((n), itoa_str[4], sizeof(itoa_str[4])); })
#define U2A5(n) ({ ultoa_r((n), itoa_str[5], sizeof(itoa_str[5])); })
#define U2A6(n) ({ ultoa_r((n), itoa_str[6], sizeof(itoa_str[6])); })
#define U2A7(n) ({ ultoa_r((n), itoa_str[7], sizeof(itoa_str[7])); })
#define U2A8(n) ({ ultoa_r((n), itoa_str[8], sizeof(itoa_str[8])); })
#define U2A9(n) ({ ultoa_r((n), itoa_str[9], sizeof(itoa_str[9])); })

/* The same macros provide HTML encoding of numbers */
#define U2H0(n) ({ ulltoh_r((n), itoa_str[0], sizeof(itoa_str[0])); })
#define U2H1(n) ({ ulltoh_r((n), itoa_str[1], sizeof(itoa_str[1])); })
#define U2H2(n) ({ ulltoh_r((n), itoa_str[2], sizeof(itoa_str[2])); })
#define U2H3(n) ({ ulltoh_r((n), itoa_str[3], sizeof(itoa_str[3])); })
#define U2H4(n) ({ ulltoh_r((n), itoa_str[4], sizeof(itoa_str[4])); })
#define U2H5(n) ({ ulltoh_r((n), itoa_str[5], sizeof(itoa_str[5])); })
#define U2H6(n) ({ ulltoh_r((n), itoa_str[6], sizeof(itoa_str[6])); })
#define U2H7(n) ({ ulltoh_r((n), itoa_str[7], sizeof(itoa_str[7])); })
#define U2H8(n) ({ ulltoh_r((n), itoa_str[8], sizeof(itoa_str[8])); })
#define U2H9(n) ({ ulltoh_r((n), itoa_str[9], sizeof(itoa_str[9])); })

/*
 * This function simply returns a locally allocated string containing the ascii
 * representation for number 'n' in decimal, unless n is 0 in which case it
 * returns the alternate string (or an empty string if the alternate string is
 * NULL). It use is intended for limits reported in reports, where it's
 * desirable not to display anything if there is no limit. Warning! it shares
 * the same vector as ultoa_r().
 */
extern const char *limit_r(unsigned long n, char *buffer, int size, const char *alt);

/* Fast macros to convert up to 10 different parameters inside a same call of
 * expression. Warning! they share the same vectors as U2A*!
 */
#define LIM2A0(n, alt) ({ limit_r((n), itoa_str[0], sizeof(itoa_str[0]), (alt)); })
#define LIM2A1(n, alt) ({ limit_r((n), itoa_str[1], sizeof(itoa_str[1]), (alt)); })
#define LIM2A2(n, alt) ({ limit_r((n), itoa_str[2], sizeof(itoa_str[2]), (alt)); })
#define LIM2A3(n, alt) ({ limit_r((n), itoa_str[3], sizeof(itoa_str[3]), (alt)); })
#define LIM2A4(n, alt) ({ limit_r((n), itoa_str[4], sizeof(itoa_str[4]), (alt)); })
#define LIM2A5(n, alt) ({ limit_r((n), itoa_str[5], sizeof(itoa_str[5]), (alt)); })
#define LIM2A6(n, alt) ({ limit_r((n), itoa_str[6], sizeof(itoa_str[6]), (alt)); })
#define LIM2A7(n, alt) ({ limit_r((n), itoa_str[7], sizeof(itoa_str[7]), (alt)); })
#define LIM2A8(n, alt) ({ limit_r((n), itoa_str[8], sizeof(itoa_str[8]), (alt)); })
#define LIM2A9(n, alt) ({ limit_r((n), itoa_str[9], sizeof(itoa_str[9]), (alt)); })

/*
 * Returns non-zero if character <s> is a hex digit (0-9, a-f, A-F), else zero.
 */
extern int ishex(char s);

/*
 * Return integer equivalent of character <c> for a hex digit (0-9, a-f, A-F),
 * otherwise -1.
 */
extern int hex2i(int c);

/*
 * Checks <name> for invalid characters. Valid chars are [A-Za-z0-9_:.-]. If an
 * invalid character is found, a pointer to it is returned. If everything is
 * fine, NULL is returned.
 */
extern const char *invalid_char(const char *name);

/*
 * Checks <domainname> for invalid characters. Valid chars are [A-Za-z0-9_.-].
 * If an invalid character is found, a pointer to it is returned.
 * If everything is fine, NULL is returned.
 */
extern const char *invalid_domainchar(const char *name);

/*
 * converts <str> to a struct sockaddr_un* which is locally allocated.
 * The format is "/path", where "/path" is a path to a UNIX domain socket.
 */
struct sockaddr_un *str2sun(const char *str);

/*
 * converts <str> to a struct sockaddr_in* which is locally allocated.
 * The format is "addr:port", where "addr" can be a dotted IPv4 address,
 * a host name, or empty or "*" to indicate INADDR_ANY.
 */
struct sockaddr_in *str2sa(char *str);

/*
 * converts <str> to a struct sockaddr_in* which is locally allocated, and a
 * port range consisting in two integers. The low and high end are always set
 * even if the port is unspecified, in which case (0,0) is returned. The low
 * port is set in the sockaddr_in. Thus, it is enough to check the size of the
 * returned range to know if an array must be allocated or not. The format is
 * "addr[:port[-port]]", where "addr" can be a dotted IPv4 address, a host
 * name, or empty or "*" to indicate INADDR_ANY.
 */
struct sockaddr_in *str2sa_range(char *str, int *low, int *high);

/* converts <str> to a struct in_addr containing a network mask. It can be
 * passed in dotted form (255.255.255.0) or in CIDR form (24). It returns 1
 * if the conversion succeeds otherwise non-zero.
 */
int str2mask(const char *str, struct in_addr *mask);

/*
 * converts <str> to two struct in_addr* which must be pre-allocated.
 * The format is "addr[/mask]", where "addr" cannot be empty, and mask
 * is optionnal and either in the dotted or CIDR notation.
 * Note: "addr" can also be a hostname. Returns 1 if OK, 0 if error.
 */
int str2net(const char *str, struct in_addr *addr, struct in_addr *mask);

/*
 * Parse IP address found in url.
 */
int url2ip(const char *addr, struct in_addr *dst);

/*
 * Resolve destination server from URL. Convert <str> to a sockaddr_in*.
 */
int url2sa(const char *url, int ulen, struct sockaddr_in *addr);

/* will try to encode the string <string> replacing all characters tagged in
 * <map> with the hexadecimal representation of their ASCII-code (2 digits)
 * prefixed by <escape>, and will store the result between <start> (included)
 * and <stop> (excluded), and will always terminate the string with a '\0'
 * before <stop>. The position of the '\0' is returned if the conversion
 * completes. If bytes are missing between <start> and <stop>, then the
 * conversion will be incomplete and truncated. If <stop> <= <start>, the '\0'
 * cannot even be stored so we return <start> without writing the 0.
 * The input string must also be zero-terminated.
 */
extern const char hextab[];
char *encode_string(char *start, char *stop,
		    const char escape, const fd_set *map,
		    const char *string);

/* Decode an URL-encoded string in-place. The resulting string might
 * be shorter. If some forbidden characters are found, the conversion is
 * aborted, the string is truncated before the issue and non-zero is returned,
 * otherwise the operation returns non-zero indicating success.
 */
int url_decode(char *string);

/* This one is 6 times faster than strtoul() on athlon, but does
 * no check at all.
 */
static inline unsigned int __str2ui(const char *s)
{
	unsigned int i = 0;
	while (*s) {
		i = i * 10 - '0';
		i += (unsigned char)*s++;
	}
	return i;
}

/* This one is 5 times faster than strtoul() on athlon with checks.
 * It returns the value of the number composed of all valid digits read.
 */
static inline unsigned int __str2uic(const char *s)
{
	unsigned int i = 0;
	unsigned int j;
	while (1) {
		j = (*s++) - '0';
		if (j > 9)
			break;
		i *= 10;
		i += j;
	}
	return i;
}

/* This one is 28 times faster than strtoul() on athlon, but does
 * no check at all!
 */
static inline unsigned int __strl2ui(const char *s, int len)
{
	unsigned int i = 0;
	while (len-- > 0) {
		i = i * 10 - '0';
		i += (unsigned char)*s++;
	}
	return i;
}

/* This one is 7 times faster than strtoul() on athlon with checks.
 * It returns the value of the number composed of all valid digits read.
 */
static inline unsigned int __strl2uic(const char *s, int len)
{
	unsigned int i = 0;
	unsigned int j, k;

	while (len-- > 0) {
		j = (*s++) - '0';
		k = i * 10;
		if (j > 9)
			break;
		i = k + j;
	}
	return i;
}

/* This function reads an unsigned integer from the string pointed to by <s>
 * and returns it. The <s> pointer is adjusted to point to the first unread
 * char. The function automatically stops at <end>.
 */
static inline unsigned int __read_uint(const char **s, const char *end)
{
	const char *ptr = *s;
	unsigned int i = 0;
	unsigned int j, k;

	while (ptr < end) {
		j = *ptr - '0';
		k = i * 10;
		if (j > 9)
			break;
		i = k + j;
		ptr++;
	}
	*s = ptr;
	return i;
}

extern unsigned int str2ui(const char *s);
extern unsigned int str2uic(const char *s);
extern unsigned int strl2ui(const char *s, int len);
extern unsigned int strl2uic(const char *s, int len);
extern int strl2ic(const char *s, int len);
extern int strl2irc(const char *s, int len, int *ret);
extern int strl2llrc(const char *s, int len, long long *ret);
extern unsigned int read_uint(const char **s, const char *end);
unsigned int inetaddr_host(const char *text);
unsigned int inetaddr_host_lim(const char *text, const char *stop);
unsigned int inetaddr_host_lim_ret(const char *text, char *stop, const char **ret);

static inline char *cut_crlf(char *s) {

	while (*s != '\r' || *s == '\n') {
		char *p = s++;

		if (!*p)
			return p;
	}

	*s++ = 0;

	return s;
}

static inline char *ltrim(char *s, char c) {

	if (c)
		while (*s == c)
			s++;

	return s;
}

static inline char *rtrim(char *s, char c) {

	char *p = s + strlen(s);

	while (p-- > s)
		if (*p == c)
			*p = '\0';
		else
			break;

	return s;
}

static inline char *alltrim(char *s, char c) {

	rtrim(s, c);

	return ltrim(s, c);
}

/* This function converts the time_t value <now> into a broken out struct tm
 * which must be allocated by the caller. It is highly recommended to use this
 * function intead of localtime() because that one requires a time_t* which
 * is not always compatible with tv_sec depending on OS/hardware combinations.
 */
static inline void get_localtime(const time_t now, struct tm *tm)
{
	localtime_r(&now, tm);
}

/* This function converts the time_t value <now> into a broken out struct tm
 * which must be allocated by the caller. It is highly recommended to use this
 * function intead of gmtime() because that one requires a time_t* which
 * is not always compatible with tv_sec depending on OS/hardware combinations.
 */
static inline void get_gmtime(const time_t now, struct tm *tm)
{
	gmtime_r(&now, tm);
}

/* This function parses a time value optionally followed by a unit suffix among
 * "d", "h", "m", "s", "ms" or "us". It converts the value into the unit
 * expected by the caller. The computation does its best to avoid overflows.
 * The value is returned in <ret> if everything is fine, and a NULL is returned
 * by the function. In case of error, a pointer to the error is returned and
 * <ret> is left untouched.
 */
extern const char *parse_time_err(const char *text, unsigned *ret, unsigned unit_flags);
extern const char *parse_size_err(const char *text, unsigned *ret);

/* unit flags to pass to parse_time_err */
#define TIME_UNIT_US   0x0000
#define TIME_UNIT_MS   0x0001
#define TIME_UNIT_S    0x0002
#define TIME_UNIT_MIN  0x0003
#define TIME_UNIT_HOUR 0x0004
#define TIME_UNIT_DAY  0x0005
#define TIME_UNIT_MASK 0x0007

/* Multiply the two 32-bit operands and shift the 64-bit result right 32 bits.
 * This is used to compute fixed ratios by setting one of the operands to
 * (2^32*ratio).
 */
static inline unsigned int mul32hi(unsigned int a, unsigned int b)
{
	return ((unsigned long long)a * b) >> 32;
}

/* copies at most <n> characters from <src> and always terminates with '\0' */
char *my_strndup(const char *src, int n);

/* This function returns the first unused key greater than or equal to <key> in
 * ID tree <root>. Zero is returned if no place is found.
 */
unsigned int get_next_id(struct eb_root *root, unsigned int key);

/* This function compares a sample word possibly followed by blanks to another
 * clean word. The compare is case-insensitive. 1 is returned if both are equal,
 * otherwise zero. This intends to be used when checking HTTP headers for some
 * values.
 */
int word_match(const char *sample, int slen, const char *word, int wlen);

#endif /* _COMMON_STANDARD_H */
