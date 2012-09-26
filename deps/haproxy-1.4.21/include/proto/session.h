/*
  include/proto/session.h
  This file defines everything related to sessions.

  Copyright (C) 2000-2008 Willy Tarreau - w@1wt.eu

  This library is free software; you can redistribute it and/or
  modify it under the terms of the GNU Lesser General Public
  License as published by the Free Software Foundation, version 2.1
  exclusively.

  This library is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
  Lesser General Public License for more details.

  You should have received a copy of the GNU Lesser General Public
  License along with this library; if not, write to the Free Software
  Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
*/

#ifndef _PROTO_SESSION_H
#define _PROTO_SESSION_H

#include <common/config.h>
#include <common/memory.h>
#include <types/session.h>

extern struct pool_head *pool2_session;
extern struct list sessions;

void session_free(struct session *s);

/* perform minimal intializations, report 0 in case of error, 1 if OK. */
int init_session();

void session_process_counters(struct session *s);
void sess_change_server(struct session *sess, struct server *newsrv);
struct task *process_session(struct task *t);
void sess_set_term_flags(struct session *s);
void default_srv_error(struct session *s, struct stream_interface *si);

static void inline trace_term(struct session *s, unsigned int code)
{
	s->term_trace <<= TT_BIT_SHIFT;
	s->term_trace |= code;
}

#endif /* _PROTO_SESSION_H */

/*
 * Local variables:
 *  c-indent-level: 8
 *  c-basic-offset: 8
 * End:
 */
