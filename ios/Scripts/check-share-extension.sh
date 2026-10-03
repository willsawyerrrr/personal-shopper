#!/usr/bin/env bash
# Fails unless the generated Share extension Info.plist has an activation rule
# dictionary; without one iOS never shows the extension in the share sheet.
set -euo pipefail
cd "$(dirname "$0")/.."
plist=${1:-ShareExtension/Info.plist}
rule=NSExtension:NSExtensionAttributes:NSExtensionActivationRule
for key in WebURLWithMaxCount WebPageWithMaxCount Text; do
  /usr/libexec/PlistBuddy -c "Print $rule:NSExtensionActivationSupports$key" "$plist" >/dev/null
done
