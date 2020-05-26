#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
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
TAP_EXEC	:= ./node_modules/.bin/tap

#
# Files
#
DOC_FILES	 = index.md
JS_FILES	:= $(shell ls *.js) $(shell find lib test -name '*.js' | grep -v buckets)
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SMF_MANIFESTS_IN = smf/manifests/$(NAME).xml.in smf/manifests/haproxy.xml.in

#
# Variables
#

SHELL=bash

NODE_PREBUILT_VERSION=v6.17.0
NODE_PREBUILT_TAG=zone64
NODE_PREBUILT_IMAGE=c2c31b00-1d60-11e9-9a77-ff9f06554b0f

ENGBLD_USE_BUILDIMAGE = true
ENGBLD_REQUIRE := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

include ./deps/eng/tools/mk/Makefile.ctf.defs
include ./tools/mk/Makefile.haproxy.defs
include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
include ./deps/eng/tools/mk/Makefile.smf.defs

#
# Env vars
#
PATH	:= $(NODE_INSTALL)/bin:${PATH}

RELEASE_TARBALL		:= muppet-pkg-$(STAMP).tar.gz
ROOT			:= $(shell pwd)
RELSTAGEDIR			:= /tmp/$(NAME)-$(STAMP)

# our base image is triton-origin-x86_64-18.4.0
BASE_IMAGE_UUID = a9368831-958e-432d-a031-f8ce6768d190
BUILDIMAGE_NAME = mantav1-loadbalancer
BUILDIMAGE_DESC	= Manta loadbalancer
BUILDIMAGE_PKGSRC = openssl-1.0.2p
AGENTS		= amon config registrar

# For mantav1, specify the branch to compare copyrights with
ENGBLD_CHECK_COPYRIGHT_ARGS = -b mantav1

#
# Repo-specific targets
#
.PHONY: all
all $(TAP_EXEC): $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS) $(HAPROXY_EXEC) scripts
	$(NPM) install --no-save

DISTCLEAN_FILES += ./node_modules

.PHONY: test

# need to sed out leading whitespace for bunyan to trigger
test: $(TAP_EXEC)
	$(TAP_EXEC) --strict -T 60 test/*.test.js > >(sed 's+^    {+{+' | bunyan)

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
		$(ROOT)/test \
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
include ./deps/eng/tools/mk/Makefile.ctf.targ
include ./tools/mk/Makefile.haproxy.targ
include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
