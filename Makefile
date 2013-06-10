#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

MY_NAME		:= muppet

#
# Tools
#
BUNYAN		:= ./node_modules/.bin/bunyan
NODEUNIT	:= ./node_modules/.bin/nodeunit

#
# Files
#
DOC_FILES	 = index.restdown
JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js' | grep -v buckets)
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/$(MY_NAME).xml.in smf/manifests/haproxy.xml.in

#
# Variables
#

NODE_PREBUILT_TAG	= zone
NODE_PREBUILT_VERSION	:= v0.8.23

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.haproxy.defs
include ./tools/mk/Makefile.node_prebuilt.defs
include ./tools/mk/Makefile.node_deps.defs
include ./tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:${PATH}

#
# MG Variables
#

RELEASE_TARBALL		:= muppet-pkg-$(STAMP).tar.bz2
ROOT			:= $(shell pwd)
TMPDIR			:= /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NODEUNIT) $(REPO_DEPS) $(HAPROXY_EXEC)
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit
DISTCLEAN_FILES += ./node_modules muppet-pkg-*.tar.bz2

.PHONY: test
test: $(NODEUNIT)
	$(NODEUNIT) test/*.test.js 2>&1 | $(BUNYAN)

.PHONY: release
release: all docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(TMPDIR)/site
	@touch $(TMPDIR)/site/.do-not-delete-me
	@mkdir -p $(TMPDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@mkdir -p $(TMPDIR)/root/opt/smartdc/$(MY_NAME)/smf/manifests
	@cp $(ROOT)/etc/haproxy.cfg.default $(TMPDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/etc/haproxy.cfg.in $(TMPDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/etc/*.http $(TMPDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/smf/manifests/*.xml \
		$(TMPDIR)/root/opt/smartdc/$(MY_NAME)/smf/manifests

	cp -r	$(ROOT)/build \
		$(ROOT)/lib \
		$(ROOT)/main.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(TMPDIR)/root/opt/smartdc/$(MY_NAME)
	(cd $(TMPDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(TMPDIR)

.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(MY_NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/$(MY_NAME)/$(RELEASE_TARBALL)


include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.haproxy.targ
include ./tools/mk/Makefile.node_prebuilt.targ
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
