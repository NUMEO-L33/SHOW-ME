#!/bin/bash
set -euo pipefail

# Dependency installation only. Never synchronize the scaffold's empty lib/db
# schema with ShowMe's database here. The processor applies its reviewed SQL
# migrations during its own guarded startup lifecycle.
pnpm install --frozen-lockfile
