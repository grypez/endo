#!/bin/bash
alias endo=$PWD/bin/endo
cd demo
endo purge -f

endo make counter.js --name counter
