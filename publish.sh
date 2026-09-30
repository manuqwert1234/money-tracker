#!/bin/zsh
# Publishes the app: stamps a build id (so phones auto-reload), updates Google Apps Script, pushes to GitHub Pages.
# Usage: ./publish.sh "what changed"
set -e
cd "$(dirname "$0")"
MSG=${1:-"Update"}
BUILD=$(date +%Y%m%d%H%M%S)

sed "s/const BUILD = '__BUILD__'/const BUILD = '$BUILD'/" Index.html > docs/index.html
echo "$BUILD" > docs/version.txt
sed -i '' -E "s/const CACHE = 'money-[^']+'/const CACHE = 'money-$BUILD'/" docs/sw.js

cp Index.html gas/Index.html
cp Code.gs gas/Code.js
(cd gas && clasp push -f >/dev/null && clasp deploy -i AKfycbx_89qVHduJzbO_V24J36aoPk6fkId-RgIDZ4agAk3h33-DLOeyvNLFz7gaWoz5fZM_ --description "$BUILD" | tail -1)

git add -A
git commit -qm "$MSG"
git push -q
echo "published build $BUILD"
