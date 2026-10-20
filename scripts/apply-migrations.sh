#!/usr/bin/env bash
# Applies each `supabase/migrations/*.sql` that the project's migration history
# lacks (matched by name), in filename order, through the Supabase Management
# API. Needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF.
set -euo pipefail

api="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/migrations"
auth="Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}"

applied=$(curl --fail-with-body -sS -H "$auth" "$api" | jq -r '.[].name')

for file in supabase/migrations/*.sql; do
  name=$(basename "$file" .sql)
  name=${name#*_}
  if grep -qx "$name" <<<"$applied"; then
    continue
  fi
  echo "Applying $file"
  jq -n --arg name "$name" --rawfile query "$file" '{name: $name, query: $query}' |
    curl --fail-with-body -sS -X POST -H "$auth" -H 'Content-Type: application/json' -d @- "$api"
done
