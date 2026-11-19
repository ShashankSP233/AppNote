#!/usr/bin/env bash
# Revised quotations, end to end against a running server.
#   bash test/e2e-versions.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000/api}"
PW="${DEMO_PASSWORD:-admin123}"
JAR=$(mktemp -d)/cookies
PASS=0; FAIL=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

login() {
  rm -f "$JAR"
  curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PW\"}" > /dev/null
}
as()   { curl -s -b "$JAR" -c "$JAR" "$@"; }
pick() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?'':v)}catch(e){console.log('')}})" "$1"; }
note() { as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const n=JSON.parse(s).note;let v;try{v=eval(process.argv[1])}catch(e){v=''}console.log(v===undefined||v===null?'':v)})" "$1"; }

login jaswinder

say "Set up a note with two vendors"
PROJECT=$(as "$BASE/projects" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).projects[0].id))")
REQ=$(as -X POST "$BASE/requisitions" -H 'Content-Type: application/json' \
  -d "{\"requisition_no\":\"REQ/VER/26-27/$$-$(date +%s)\",\"project_id\":$PROJECT,\"purpose\":\"Version test\"}" | pick requisition.id)
NOTE=$(as -X POST "$BASE/notes" -H 'Content-Type: application/json' \
  -d "{\"subject\":\"Revised quotation test\",\"project_id\":$PROJECT,\"requisition_id\":$REQ}" | pick note.id)
ok "note $NOTE created"

add_vendor() { # name amount -> prints quotation id
  local qid
  qid=$(as -X POST "$BASE/notes/$NOTE/quotations" -F "vendor_name=$1" -F "extract=false" | pick quotation_id)
  as -X PUT "$BASE/quotations/$qid/items" -H 'Content-Type: application/json' \
    -d "{\"items\":[{\"description\":\"Supply package\",\"quantity\":1,\"unit\":\"Lot\",\"rate\":$2,\"amount\":$2}]}" > /dev/null
  as -X PATCH "$BASE/quotations/$qid" -H 'Content-Type: application/json' \
    -d '{"gst_rate":18,"delivery_days":20,"advance_percent":30}' > /dev/null
  as -X POST "$BASE/quotations/$qid/confirm" -H 'Content-Type: application/json' -d '{}' > /dev/null
  echo "$qid"
}

Q1=$(add_vendor "Alpha Engineering" 100000)
Q2=$(add_vendor "Beta Marine" 92000)
ok "Alpha quotation $Q1 at 1,00,000 and Beta $Q2 at 92,000"

check "$(note 'n.comparison.lowest.vendor_name')" "Beta Marine" "Beta is L1 before any revision"

say "Alpha sends a revised offer"
REV=$(as -X POST "$BASE/quotations/$Q1/revise" \
  -F "revision_note=After negotiation on 2 August" \
  -F "quotation_ref=ALPHA/REV/2" \
  -F "extract=false")
Q1V2=$(echo "$REV" | pick quotation_id)
VER=$(echo "$REV" | pick version_no)
CARRIED=$(echo "$REV" | pick items_carried_over)

check "$VER" "2" "the revision is version 2"
check "$CARRIED" "true" "the previous version's lines were copied across"

say "The note shows one offer per vendor, not one per version"
check "$(note 'n.quotations.length')" "2" "still two offers on the note"
check "$(note 'n.comparison.rows.length')" "2" "and two rows in the comparison"
check "$(note "n.quotations.find(q=>q.vendor_name==='Alpha Engineering').version_no")" "2" "Alpha shows as version 2"
check "$(note "n.quotations.find(q=>q.vendor_name==='Alpha Engineering').history.length")" "1" "with one earlier version kept"

say "Lines carried into a revision are flagged for checking"
NEEDS=$(note "n.quotations.find(q=>q.vendor_name==='Alpha Engineering').items.filter(i=>i.needs_review).length")
check "$NEEDS" "1" "the carried-over line asks to be checked"

BLOCKED=$(note "n.readiness.blocking.some(b=>/confirm/i.test(b)) ? 'yes' : 'no'")
check "$BLOCKED" "yes" "and the unconfirmed revision blocks submission"

say "Drop Alpha's price and confirm the revision"
as -X PUT "$BASE/quotations/$Q1V2/items" -H 'Content-Type: application/json' \
  -d '{"items":[{"description":"Supply package","quantity":1,"unit":"Lot","rate":85000,"amount":85000}]}' > /dev/null
as -X POST "$BASE/quotations/$Q1V2/confirm" -H 'Content-Type: application/json' -d '{}' > /dev/null

check "$(note 'n.comparison.lowest.vendor_name')" "Alpha Engineering" "the revision makes Alpha L1"
check "$(note "n.comparison.rows.find(r=>r.vendor_name==='Alpha Engineering').first_offer")" "118000" "the first offer is on record"
check "$(note "n.comparison.rows.find(r=>r.vendor_name==='Alpha Engineering').negotiated")" "17700" "and the reduction is reported"

say "Selection follows the offer across a further revision"
as -X POST "$BASE/notes/$NOTE/select-vendor" -H 'Content-Type: application/json' \
  -d "{\"quotation_id\":$Q1V2,\"reason\":\"Lowest after negotiation.\"}" > /dev/null
check "$(note 'n.selected_quotation.vendor_name')" "Alpha Engineering" "Alpha selected"

REV3=$(as -X POST "$BASE/quotations/$Q1V2/revise" -F "revision_note=Final price" -F "extract=false")
Q1V3=$(echo "$REV3" | pick quotation_id)
check "$(echo "$REV3" | pick version_no)" "3" "a third version"
check "$(note 'n.selected_quotation.id')" "$Q1V3" "the selection moved to the new version automatically"
check "$(note "n.quotations.find(q=>q.vendor_name==='Alpha Engineering').history.length")" "2" "two earlier versions kept"

say "A superseded version cannot itself be revised"
CODE=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/quotations/$Q1/revise" -F "revision_note=x" -F "extract=false")
check "$CODE" "409" "revising an old version is refused"

say "The version list reads newest first"
as "$BASE/quotations/$Q1V3/versions" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s).versions;console.log('   versions: '+v.map(x=>'v'+x.version_no).join(', '))})"
VCOUNT=$(as "$BASE/quotations/$Q1V3/versions" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).versions.length))")
check "$VCOUNT" "3" "all three versions returned"

say "Deleting the newest version brings the previous one back"
as -X POST "$BASE/quotations/$Q1V3/confirm" -H 'Content-Type: application/json' -d '{}' > /dev/null
as -X DELETE "$BASE/quotations/$Q1V3" > /dev/null
check "$(note 'n.quotations.length')" "2" "still two offers"
check "$(note "n.quotations.find(q=>q.vendor_name==='Alpha Engineering').id")" "$Q1V2" "version 2 is live again"
check "$(note 'n.selected_quotation.id')" "$Q1V2" "and is selected again"

say "The document carries the revision history"
as -o /tmp/ver.docx -w '' "$BASE/notes/$NOTE/document"
SIZE=$(stat -c%s /tmp/ver.docx)
[ "$SIZE" -gt 8000 ] && ok ".docx generated (${SIZE} bytes)" || bad ".docx too small"

as -o /tmp/ver.zip -w '' "$BASE/notes/$NOTE/package"
unzip -l /tmp/ver.zip > /tmp/ver.list 2>/dev/null
grep -q "CONTENTS.txt" /tmp/ver.list && ok "package built" || bad "no package"

ANNEX=$(as "$BASE/notes/$NOTE/annexures" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).annexures.length))")
check "$ANNEX" "4" "one annexure per offer, not per version"

printf '\n\033[1mPassed %d, failed %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
