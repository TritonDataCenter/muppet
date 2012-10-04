# Muppet

Muppet is a custom haproxy (patched) and small daemon that interacts with
ZooKeeper via registrar.  The muppet daemon will update haproxy with new
configuration as hosts come and go from the given service name.

# Development

Run `make prepush` before commits; otherwise, follow
JEG: https://mo.joyent.com/docs/eng

# License

Copyright (c) 2012, Joyent, Inc. All rights reserved.
