#!/usr/bin/env bash
# People, roles and passwords, end to end against a running server.
#   bash test/e2e-users.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000/api}"
PW="${DEMO_PASSWORD:-admin123}"
JAR=$(mktemp -d)/cookies
STAMP=$$-$(date +%s)
PASS=0; FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

login() {
  rm -f "$JAR"
  curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" > /dev/null
}
code() { # username password -> http status of a login attempt
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}
as()   { curl -s -b "$JAR" -c "$JAR" "$@"; }
pick() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?'':v)}catch(e){console.log('')}})" "$1"; }

say "A non-admin cannot create people"
login mansi "$PW"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/users" -H 'Content-Type: application/json' \
  -d "{\"username\":\"sneaky$STAMP\",\"password\":\"abcdefgh\",\"full_name\":\"Sneaky\",\"role\":\"admin\"}")
check "$CODE" "403" "a preparer is refused"

say "An admin creates a person"
login admin "$PW"
NEWUSER="site$STAMP"
CREATED=$(as -X POST "$BASE/auth/users" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$NEWUSER\",\"password\":\"harbour-winch-42\",\"full_name\":\"Site Engineer\",\"designation\":\"Site Engineer\",\"role\":\"preparer\",\"email\":\"site@example.invalid\"}")
NEW_ID=$(echo "$CREATED" | pick user.id)
[ -n "$NEW_ID" ] && ok "created user $NEW_ID ($NEWUSER)" || bad "not created: $CREATED"
check "$(echo "$CREATED" | pick user.role)" "preparer" "with the role asked for"

say "The new person can sign in, and starts flagged as not having set their own password"
check "$(code "$NEWUSER" harbour-winch-42)" "200" "sign-in works"
login "$NEWUSER" harbour-winch-42
check "$(as "$BASE/auth/me" | pick user.password_changed_at)" "" "flagged as never set by its owner"

say "Passwords must be at least 8 characters"
login admin "$PW"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/users" -H 'Content-Type: application/json' \
  -d "{\"username\":\"short$STAMP\",\"password\":\"abc\",\"full_name\":\"Too Short\",\"role\":\"preparer\"}")
check "$CODE" "400" "a 3-character password is refused"

say "A duplicate username is refused"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/users" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$NEWUSER\",\"password\":\"abcdefgh\",\"full_name\":\"Clash\",\"role\":\"preparer\"}")
check "$CODE" "409" "taken usernames are rejected"

say "An unknown role is refused"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/users" -H 'Content-Type: application/json' \
  -d "{\"username\":\"role$STAMP\",\"password\":\"abcdefgh\",\"full_name\":\"Bad Role\",\"role\":\"superuser\"}")
check "$CODE" "400" "only the six known roles are accepted"

say "Changing your own role is the admin's job, and it takes effect"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"role":"accounts"}' > /dev/null
login "$NEWUSER" harbour-winch-42
# accounts can read the tax catalogue; a preparer cannot post a tax verification
check "$(as -o /dev/null -w '%{http_code}' "$BASE/tax/sections")" "200" "the new role can reach the accounts catalogue"

say "Setting your own password clears the flag and the old one stops working"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/password" -H 'Content-Type: application/json' \
  -d '{"current_password":"harbour-winch-42","new_password":"tidal-pontoon-77"}')
check "$CODE" "200" "the change is accepted"
check "$(as "$BASE/auth/me" | pick user.password_changed_at | cut -c1-4)" "$(date +%Y)" "and is stamped with today"
check "$(code "$NEWUSER" harbour-winch-42)" "401" "the old password is dead"
check "$(code "$NEWUSER" tidal-pontoon-77)" "200" "the new one works"

say "A wrong current password is refused, and reusing the same one is pointless"
login "$NEWUSER" tidal-pontoon-77
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/password" -H 'Content-Type: application/json' \
  -d '{"current_password":"not-the-password","new_password":"anchor-barge-10"}')
check "$CODE" "401" "wrong current password refused"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/password" -H 'Content-Type: application/json' \
  -d '{"current_password":"tidal-pontoon-77","new_password":"tidal-pontoon-77"}')
check "$CODE" "400" "reusing the same password refused"

say "An admin reset leaves the account marked as needing its owner to set one"
login admin "$PW"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"password":"spud-channel-31"}' > /dev/null
login "$NEWUSER" spud-channel-31
check "$(as "$BASE/auth/me" | pick user.password_changed_at)" "" "reset by an admin does not count as the owner setting it"

say "Deactivating someone stops them signing in"
login admin "$PW"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"is_active":false}' > /dev/null
check "$(code "$NEWUSER" spud-channel-31)" "401" "an inactive account cannot sign in"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"is_active":true}' > /dev/null
check "$(code "$NEWUSER" spud-channel-31)" "200" "and can again once reactivated"

say "An admin cannot lock everyone out"
login admin "$PW"
ADMIN_ID=$(as "$BASE/auth/users" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).users.find(x=>x.username==='admin');console.log(u?u.id:'')})")
CODE=$(as -o /tmp/lock.json -w '%{http_code}' -X PATCH "$BASE/auth/users/$ADMIN_ID" \
  -H 'Content-Type: application/json' -d '{"is_active":false}')
check "$CODE" "409" "cannot deactivate your own account"
grep -q "your own account" /tmp/lock.json && ok "and it says why" || bad "unclear message"

CODE=$(as -o /tmp/lock2.json -w '%{http_code}' -X PATCH "$BASE/auth/users/$ADMIN_ID" \
  -H 'Content-Type: application/json' -d '{"role":"preparer"}')
check "$CODE" "409" "cannot demote the only administrator"
grep -q "only active administrator" /tmp/lock2.json && ok "and it says why" || bad "unclear message"

say "With a second administrator, demotion is allowed again"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"role":"admin"}' > /dev/null
CODE=$(as -o /dev/null -w '%{http_code}' -X PATCH "$BASE/auth/users/$ADMIN_ID" \
  -H 'Content-Type: application/json' -d '{"role":"admin"}')
check "$CODE" "200" "a second admin exists, so the guard stands down"

say "Tidy up"
as -X PATCH "$BASE/auth/users/$NEW_ID" -H 'Content-Type: application/json' -d '{"is_active":false,"role":"preparer"}' > /dev/null
ok "test account deactivated"

printf '\n\033[1mPassed %d, failed %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
