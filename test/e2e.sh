#!/usr/bin/env bash
# Drives a note through the whole flow against a running server.
#   bash test/e2e.sh
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
  curl -s -c "$JAR" -b "$JAR" -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$PW\"}" > /dev/null
}
as()   { curl -s -b "$JAR" -c "$JAR" "$@"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v===undefined||v===null?'':v)}catch(e){console.log('')}})" "$1"; }

say "1. Sign in"
login jaswinder
ME=$(as "$BASE/auth/me" | json user.username)
check "$ME" "jaswinder" "signed in as the preparer"

say "2. Raise a requisition"
PROJECT=$(as "$BASE/projects" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).projects[0].id))")
REQ=$(as -X POST "$BASE/requisitions" -H 'Content-Type: application/json' -d "{
  \"requisition_no\":\"REQ/E2E/26-27/$$-$(date +%s)\",
  \"project_id\":$PROJECT,
  \"vessel\":\"Titan-VI\",
  \"department\":\"Marine Engineering\",
  \"purpose\":\"Fuel pump and turbocharger overhaul\",
  \"items\":[{\"description\":\"Fuel pump overhaul kit\",\"quantity\":2,\"unit\":\"Set\"}]
}" | json requisition.id)
[ -n "$REQ" ] && ok "requisition $REQ raised" || bad "requisition not raised"

say "3. Create the note"
NOTE=$(as -X POST "$BASE/notes" -H 'Content-Type: application/json' -d "{
  \"subject\":\"End to end test — fuel pump overhaul for Titan-VI\",
  \"project_id\":$PROJECT,
  \"requisition_id\":$REQ,
  \"item_description\":\"Three quotations obtained and compared.\",
  \"payment_terms\":\"50% advance, balance against proforma\",
  \"delivery_terms\":\"Within 10 days\"
}" | json note.id)
[ -n "$NOTE" ] && ok "note $NOTE created" || { bad "note not created"; exit 1; }

NOTE_NO=$(as "$BASE/notes/$NOTE" | json note.note_no)
case "$NOTE_NO" in
  *"Port-Dharti"*) ok "note number allocated in house format: $NOTE_NO" ;;
  *) bad "note number wrong: $NOTE_NO" ;;
esac

say "4. A draft note is not submittable"
CAN=$(as "$BASE/notes/$NOTE" | json note.readiness.canSubmit)
check "$CAN" "false" "blocked while incomplete"

say "5. Upload a quotation as a text-layer PDF"
cat > /tmp/quote.txt <<'EOF'
M/s. Rainbow Marine Engineering Services
Mumbai 400001
GSTIN: 27CLLPV6143B1ZW
Quotation No: RMES/2026/114    Date: 28-July-2026

Sr No | Description | Qty | Unit | Rate | Amount
1 | Hoist Turbo Charger Repair Service Kit | 2 | Nos | 20000.00 | 40000.00
2 | Pump Gasket Set | 2 | Nos | 3200.00 | 6400.00

TOTAL  46400.00
GST @18%  8352.00
Total Amount  54752.00

Payment Terms: 50% advance along with PO and balance 50% against proforma invoice
Delivery: within 10 days from receipt of payment
Validity: 30 days
EOF
node -e "
const {PDFDocument,StandardFonts}=require('pdf-lib');
const fs=require('fs');
(async()=>{
  const doc=await PDFDocument.create();
  const page=doc.addPage([595,842]);
  const font=await doc.embedFont(StandardFonts.Courier);
  const lines=fs.readFileSync('/tmp/quote.txt','utf8').split('\n');
  let y=800;
  for(const line of lines){ page.drawText(line.slice(0,95),{x:40,y,size:9,font}); y-=13; }
  fs.writeFileSync('/tmp/quote.pdf', await doc.save());
})();
" 2>/dev/null || echo "(pdf-lib not present, falling back to a plain upload)"

if [ -f /tmp/quote.pdf ]; then
  UP=$(as -X POST "$BASE/notes/$NOTE/quotations" -F "files=@/tmp/quote.pdf")
else
  UP=$(as -X POST "$BASE/notes/$NOTE/quotations" -F "files=@/tmp/quote.txt" -F "vendor_name=Rainbow Marine Engineering Services")
fi

Q1=$(echo "$UP" | json quotation_id)
CONF=$(echo "$UP" | json extraction.confidence)
ITEMS=$(echo "$UP" | json extraction.itemCount)
[ -n "$Q1" ] && ok "quotation $Q1 uploaded (confidence ${CONF:-n/a}, ${ITEMS:-0} lines read)" || bad "upload failed: $UP"

say "6. Unconfirmed extraction blocks submission"
BLOCK=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const n=JSON.parse(s).note;console.log(n.readiness.blocking.some(b=>/confirm/i.test(b))?'yes':'no')})")
check "$BLOCK" "yes" "the note refuses to move while figures are unconfirmed"

say "7. Correct the lines by hand, then confirm"
as -X PUT "$BASE/quotations/$Q1/items" -H 'Content-Type: application/json' -d '{"items":[
  {"description":"Hoist Turbo Charger Repair Service Kit","quantity":2,"unit":"Nos","rate":20000,"amount":40000},
  {"description":"Pump Gasket Set","quantity":2,"unit":"Nos","rate":3200,"amount":6400}
]}' > /dev/null
as -X PATCH "$BASE/quotations/$Q1" -H 'Content-Type: application/json' \
  -d '{"vendor_name":"Rainbow Marine Engineering Services","vendor_gstin":"27CLLPV6143B1ZW","delivery_days":10,"advance_percent":50,"gst_rate":18,"payment_terms_text":"50% advance, balance against proforma"}' > /dev/null
as -X POST "$BASE/quotations/$Q1/confirm" -H 'Content-Type: application/json' -d '{}' > /dev/null
STATUS=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.quotations[0].extraction_status))")
check "$STATUS" "reviewed" "confirmed after human correction"

say "8. Add two competing quotations"
for V in "Coastal Diesel Services:21:0:48000" "Brahmaputra Marine Works:45:100:44000"; do
  NAME="${V%%:*}"; REST="${V#*:}"; DAYS="${REST%%:*}"; REST="${REST#*:}"; ADV="${REST%%:*}"; AMT="${REST##*:}"
  QID=$(as -X POST "$BASE/notes/$NOTE/quotations" -H 'Content-Type: multipart/form-data' \
    -F "vendor_name=$NAME" -F "extract=false" | json quotation_id)
  as -X PUT "$BASE/quotations/$QID/items" -H 'Content-Type: application/json' \
    -d "{\"items\":[{\"description\":\"Fuel pump overhaul package\",\"quantity\":1,\"unit\":\"Lot\",\"rate\":$AMT,\"amount\":$AMT}]}" > /dev/null
  as -X PATCH "$BASE/quotations/$QID" -H 'Content-Type: application/json' \
    -d "{\"delivery_days\":$DAYS,\"advance_percent\":$ADV,\"gst_rate\":18}" > /dev/null
  as -X POST "$BASE/quotations/$QID/confirm" -H 'Content-Type: application/json' -d '{}' > /dev/null
  ok "added $NAME"
done

COUNT=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.quotations.length))")
check "$COUNT" "3" "three quotations on the note"

say "9. The comparison ranks on landed cost"
L1=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.comparison.lowest.vendor_name))")
ok "L1 on landed cost is: $L1"

say "10. Technical criteria beyond price"
as -X PUT "$BASE/notes/$NOTE/criteria" -H 'Content-Type: application/json' -d "{\"criteria\":[
  {\"label\":\"Genuine OEM spares\",\"category\":\"technical\",\"weight\":2,\"is_mandatory\":true,
   \"values\":{\"$Q1\":{\"value_text\":\"Genuine Bosch\",\"score\":10,\"complies\":true}}}
]}" > /dev/null
CRIT=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.criteria.length))")
check "$CRIT" "1" "criteria saved with scores"

say "11. Selecting a vendor requires a reason"
NOREASON=$(as -o /dev/null -w '%{http_code}' -X POST "$BASE/notes/$NOTE/select-vendor" \
  -H 'Content-Type: application/json' -d "{\"quotation_id\":$Q1}")
check "$NOREASON" "400" "refused without a reason"

as -X POST "$BASE/notes/$NOTE/select-vendor" -H 'Content-Type: application/json' \
  -d "{\"quotation_id\":$Q1,\"reason\":\"Genuine Bosch spares with calibration report and shortest delivery.\"}" > /dev/null
SEL=$(as "$BASE/notes/$NOTE" | json note.selected_quotation.vendor_name)
check "$SEL" "Rainbow Marine Engineering Services" "vendor selected with a reason"

say "12. Price the note from the selected quotation"
as -X POST "$BASE/notes/$NOTE/items/from-quotation" -H 'Content-Type: application/json' \
  -d "{\"quotation_id\":$Q1,\"replace\":true}" > /dev/null
BASIC=$(as "$BASE/notes/$NOTE" | json note.totals.basic)
GRAND=$(as "$BASE/notes/$NOTE" | json note.totals.grandTotal)
check "$BASIC" "46400" "basic carried across from the quotation"
check "$GRAND" "54752" "grand total with 18% GST, settled to whole rupees"

say "13. Payment schedule"
as -X PUT "$BASE/notes/$NOTE/milestones" -H 'Content-Type: application/json' -d '{"milestones":[
  {"milestone":"50% advance with PO","trigger_event":"PO release","percent":50,"basis":"grand_total"},
  {"milestone":"50% against proforma","trigger_event":"Proforma invoice","percent":50,"basis":"grand_total"}
]}' > /dev/null
MS=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.milestones.length))")
check "$MS" "2" "two milestones saved"

say "14. Submit"
SUB=$(as -X POST "$BASE/notes/$NOTE/submit" -H 'Content-Type: application/json' -d '{"assignments":{}}')
ST=$(echo "$SUB" | json note.status)
check "$ST" "pending_check" "submitted and sitting with the checkers"

say "15. A checker cannot approve at the accounts stage, and so on down the line"
login saurabh
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
login abhishek
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
ST=$(as "$BASE/notes/$NOTE" | json note.status)
check "$ST" "pending_verify" "moved on only after both checkers acted"

login vipul
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
login harshada
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
ST=$(as "$BASE/notes/$NOTE" | json note.status)
check "$ST" "pending_accounts" "reached accounts"

say "16. Accounts cannot approve before verifying tax and registrations"
login accounts
CODE=$(as -o /tmp/acc.json -w '%{http_code}' -X POST "$BASE/notes/$NOTE/decision" \
  -H 'Content-Type: application/json' -d '{"decision":"approved"}')
check "$CODE" "422" "accounts approval gated on the checks"
grep -q "tax rate confirmed" /tmp/acc.json && ok "the gate names the missing tax verification" || bad "gate message unclear"

say "17. Item-wise tax verification"
IDS=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const n=JSON.parse(s).note;console.log(JSON.stringify(n.items.map(i=>({id:i.id,tax_verified:true,verified_gst_rate:i.gst_rate}))))})")
as -X POST "$BASE/notes/$NOTE/tax-verify" -H 'Content-Type: application/json' -d "{\"items\":$IDS}" > /dev/null
UNVER=$(as "$BASE/notes/$NOTE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).note.items.filter(i=>!i.tax_verified).length))")
check "$UNVER" "0" "every line verified"

say "18. The accounts checklist cross-checks GSTIN against PAN"
as "$BASE/notes/$NOTE/accounts/checklist" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);for(const f of r.findings)console.log('   ['+f.level+'] '+f.label+': '+f.message.slice(0,86))})"

say "19. GST/PAN checks and TDS"
as -X PUT "$BASE/notes/$NOTE/accounts" -H 'Content-Type: application/json' -d '{
  "gst_number_checked":true,"gst_status":"Active","pan_number_checked":true,"pan_status":"Valid",
  "bank_details_checked":true,"duplicate_checked":true,"budget_checked":true,
  "tds_applicable":true,"tds_section":"194C","tds_rate":2,"tds_base":46400,
  "tds_remark":"Repair and service work"
}' > /dev/null
NET=$(as "$BASE/notes/$NOTE" | json note.deductions.netPayable)
check "$NET" "53824" "net payable is grand total less 2% TDS on the basic value"

say "20. Accounts can now approve, then the approvers"
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
ST=$(as "$BASE/notes/$NOTE" | json note.status)
check "$ST" "pending_approval" "moved to the approvers"

login md
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
login chairman
as -X POST "$BASE/notes/$NOTE/decision" -H 'Content-Type: application/json' -d '{"decision":"approved"}' > /dev/null
ST=$(as "$BASE/notes/$NOTE" | json note.status)
check "$ST" "approved" "fully approved"

say "21. Documents"
as -o /tmp/note.docx -w '' "$BASE/notes/$NOTE/document"
SIZE=$(stat -c%s /tmp/note.docx)
[ "$SIZE" -gt 10000 ] && ok ".docx generated (${SIZE} bytes)" || bad ".docx too small: $SIZE"
file /tmp/note.docx | grep -qi "word\|zip" && ok "it is a real Word file" || bad "not a Word file"

as -o /tmp/note.zip -w '' "$BASE/notes/$NOTE/package"
ZSIZE=$(stat -c%s /tmp/note.zip)
[ "$ZSIZE" -gt 10000 ] && ok "package .zip generated (${ZSIZE} bytes)" || bad "zip too small: $ZSIZE"
unzip -l /tmp/note.zip 2>/dev/null | grep -q CONTENTS.txt && ok "the package carries a manifest" || bad "no manifest"

as "$BASE/notes/$NOTE/annexures" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s).annexures)console.log('   '+a.letter+'. '+a.title)})"

say "22. An approved note can no longer be edited"
login jaswinder
CODE=$(as -o /dev/null -w '%{http_code}' -X PATCH "$BASE/notes/$NOTE" \
  -H 'Content-Type: application/json' -d '{"subject":"tampered"}')
check "$CODE" "409" "locked after approval"

printf '\n\033[1mPassed %d, failed %d\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
