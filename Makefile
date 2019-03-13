#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2019, Joyent, Inc.
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

NAME		:= muppet

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
SMF_MANIFESTS_IN = smf/manifests/$(NAME).xml.in smf/manifests/haproxy.xml.in smf/manifests/stud.xml.in

#
# Variables
#

NODE_PREBUILT_TAG	= zone
NODE_PREBUILT_VERSION   := v4.6.1
NODE_PREBUILT_IMAGE     = 18b094b0-eb01-11e5-80c1-175dac7ddf02

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

include ./tools/mk/Makefile.haproxy.defs
include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:${PATH}

#
# MG Variables
#

RELEASE_TARBALL		:= muppet-pkg-$(STAMP).tar.gz
ROOT			:= $(shell pwd)
RELSTAGEDIR			:= /tmp/$(NAME)-$(STAMP)

BASE_IMAGE_UUID = 04a48d7d-6bb5-4e83-8c3b-e60a99e0f48f
BUILDIMAGE_NAME = manta-loadbalancer
BUILDIMAGE_DESC	= Manta loadbalancer
BUILDIMAGE_PKGSRC = py27-curses openssl-1.0.2o stud-0.3p53nb5 libzookeeper-3.4.6
AGENTS		= amon config registrar

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(NODEUNIT) $(REPO_DEPS) $(HAPROXY_EXEC) scripts
	$(NPM) install

$(NODEUNIT): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(NODEUNIT) ./node_modules/nodeunit
DISTCLEAN_FILES += ./node_modules

.PHONY: test
#
# Unit tests
# Right now we are ignoring the watch test until
# it is back to a working state.
#
test: $(NODEUNIT)
	$(NODEUNIT) test/config.test.js 2>&1 | $(BUNYAN)

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
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/smf/manifests
	@cp $(ROOT)/etc/haproxy.cfg.default $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc
	@cp $(ROOT)/etc/haproxy.cfg.in $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc
	@cp $(ROOT)/etc/stud.conf $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc
	@cp $(ROOT)/etc/*.http $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/etc
	@cp $(ROOT)/smf/manifests/*.xml \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/smf/manifests
	cp -r	$(ROOT)/build \
		$(ROOT)/boot \
		$(ROOT)/lib \
		$(ROOT)/muppet.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/sapi_manifests \
		$(ROOT)/smf \
		$(RELSTAGEDIR)/root/opt/smartdc/$(NAME)
	mv $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/scripts \
	    $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/boot
	ln -s /opt/smartdc/$(NAME)/boot/setup.sh \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/setup.sh
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/boot/setup.sh
	ln -s /opt/smartdc/$(NAME)/boot/configure.sh \
	    $(RELSTAGEDIR)/root/opt/smartdc/boot/configure.sh
	chmod 755 $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/boot/configure.sh
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)


include ./deps/eng/tools/mk/Makefile.deps
include ./tools/mk/Makefile.haproxy.targ
include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
