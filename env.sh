export PATH=$PWD/build/node/bin:$PWD/node_modules/.bin:$PATH

alias muppet='sudo node main.js -f ./etc/config.bh1-kvm1.json -v 2>&1 | bunyan'
