#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

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
DOC_FILES	 = index.md
JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js' | grep -v buckets)
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/$(MY_NAME).xml.in smf/manifests/haproxy.xml.in smf/manifests/stud.xml.in

#
# Variables
#

NODE_PREBUILT_TAG	= zone
NODE_PREBUILT_VERSION	:= v0.10.25
NODE_PREBUILT_IMAGE	= fd2cc906-8938-11e3-beab-4359c665ac99

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
RELSTAGEDIR			:= /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NODEUNIT) $(REPO_DEPS) $(HAPROXY_EXEC) scripts
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit
DISTCLEAN_FILES += ./node_modules muppet-pkg-*.tar.bz2

.PHONY: test
test: $(NODEUNIT)
	$(NODEUNIT) test/*.test.js 2>&1 | $(BUNYAN)

.PHONY: scripts
scripts: deps/manta-scripts/.git
	mkdir -p $(BUILD)/scripts
	cp deps/manta-scripts/*.sh $(BUILD)/scripts

.PHONY: release
release: all docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/smf/manifests
	@cp $(ROOT)/etc/haproxy.cfg.default $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/etc/haproxy.cfg.in $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/etc/*.http $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/etc
	@cp $(ROOT)/smf/manifests/*.xml \
		$(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/smf/manifests
	cp -r	$(ROOT)/build \
		$(ROOT)/boot \
		$(ROOT)/lib \
		$(ROOT)/main.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)
	mv $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/build/scripts \
	    $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/boot
	ln -s /opt/smartdc/$(MY_NAME)/boot/setup.sh \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/setup.sh
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/boot/setup.sh
	ln -s /opt/smartdc/$(MY_NAME)/boot/configure.sh \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/configure.sh
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/$(MY_NAME)/boot/configure.sh
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

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
