FROM ubuntu:18.04

ARG arch=amd64

# dependencies which must be installed for the target architecture
# we must do cross-builds on i386 as phantomjs is not available for i386
ARG _crossdeps="libglib2.0-dev libgudev-1.0-dev libjson-glib-dev libkeyutils-dev liblvm2-dev libnm-glib-dev \
    libpam0g-dev libpcp3-dev libpcp-import1-dev libpcp-pmda3-dev libpolkit-agent-1-dev libpolkit-gobject-1-dev \
    libssh-dev libsystemd-dev libkrb5-dev glib-networking pkg-config \
    libc6-dbg libglib2.0-0-dbgsym glib-networking-dbgsym"

# enable debug symbol archive (https://wiki.ubuntu.com/DebuggingProgramCrash)
RUN dpkg --add-architecture ${arch} && \
    echo ${arch} > /arch && \
    apt-get update && \
    apt-get install -y --no-install-recommends gnupg2 eatmydata && \
    echo "deb http://ddebs.ubuntu.com bionic main universe" > /etc/apt/sources.list.d/ddebs.list && \
    echo "deb http://ddebs.ubuntu.com bionic-updates main universe" >> /etc/apt/sources.list.d/ddebs.list && \
    apt-key adv --keyserver keyserver.ubuntu.com --recv-keys F2EDC64DC5AEE1F6B9C621F0C8CAB6595FDFF622 && \
    apt-get update && \
    eatmydata apt-get install -y --no-install-recommends build-essential gcc-multilib clang python3 \
      autoconf automake gdb gtk-doc-tools intltool libjavascript-minifier-xs-perl libjson-perl valgrind \
      xmlto xsltproc pyflakes3 npm nodejs git libfontconfig1 dbus ssh curl chromium-browser \
      $(for p in ${_crossdeps}; do echo $p:${arch}; done) && \
    apt-get clean

# add system user to avoid same UIDs as host's source volume
RUN adduser --system --gecos "Builder" builder

# HACK: Working around Node.js screwing around with stdio
ENV NODE_PATH /usr/bin/nodejs
RUN mv /usr/bin/node /usr/bin/nodejs
ADD turd-polish /usr/bin/node

USER builder

VOLUME /source
CMD ["/source/containers/unit-tests/run.sh"]
