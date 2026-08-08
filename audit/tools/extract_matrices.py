#!/usr/bin/env python3
"""Refined extraction: expands route alternations, applies an explicit alias map
for data objects so 'genuinely absent' is defensible."""
import json, re, os, io

BASE = r"d:\accounting_system\project plan"
OUT  = r"C:\Users\User\AppData\Local\Temp\claude\d--accounting-system\a8e19cf9-8912-49cd-ac38-a5b884368895\scratchpad"

def read(p):
    with open(os.path.join(BASE, p), encoding="utf-8") as f: return f.read()

spec = read("Accounting_Platform_Master_Specification.md")
sql  = read("schema_blueprint.sql")
api  = read("api_route_catalog.yaml")

sec_re = re.compile(r"^# (\d{2})\. (.+)$", re.M)
marks = [(m.start(), m.group(1), m.group(2)) for m in sec_re.finditer(spec)]
docs = {}
for i,(pos,num,title) in enumerate(marks):
    end = marks[i+1][0] if i+1 < len(marks) else len(spec)
    body = spec[pos:end]
    if num in docs and len(docs[num][1]) >= len(body): continue
    docs[num] = (title, body)

def subsection(body,*hs):
    for h in hs:
        m = re.search(r"^##\s+"+re.escape(h)+r"\s*$", body, re.M|re.I)
        if not m: continue
        s = m.end(); n = re.search(r"^##\s+", body[s:], re.M)
        return body[s:s+(n.start() if n else len(body)-s)]
    return ""

tables = set(re.findall(r"^CREATE TABLE (\w+) \(", sql, re.M))

# ---------------- ROUTES (expanded) ----------------
cat = set()
for m in re.finditer(r"^\s+- ((?:GET|POST|PATCH|PUT|DELETE) \S+)$", api, re.M):
    v,p = m.group(1).split(" ",1); cat.add((v,p))
def norm(p): return re.sub(r"\{[^}]*\}","{id}",p).rstrip("/").lower()
cat_paths = {}
for v,p in cat: cat_paths.setdefault(norm(p),set()).add(v)

doc_routes = {}   # (verb,path) -> {docs}
for num,(title,body) in sorted(docs.items()):
    blk = subsection(body,"APIs","APIs/events","APIs and events")
    if not blk: continue
    for raw in re.findall(r"`([^`]+)`", blk):
        for piece in re.split(r",\s*", raw):
            piece = piece.strip().rstrip(".;")
            if not piece: continue
            mv = re.match(r"^((?:GET|POST|PATCH|PUT|DELETE)(?:/(?:GET|POST|PATCH|PUT|DELETE))*)\s+(.*)$", piece)
            verbs, path = (mv.group(1).split("/"), mv.group(2)) if mv else (["?"], piece)
            if not path.startswith("/") or path == "/v1": continue
            # expand trailing alternation: /a/{id}/x|y|z  and  /reports/a|b|c
            head, sep, last = path.rpartition("/")
            paths = [f"{head}/{alt}" for alt in last.split("|")] if "|" in last else [path]
            for pth in paths:
                for v in verbs:
                    doc_routes.setdefault((v,pth), set()).add(num)

missing_paths = {}
for (v,p),ds in doc_routes.items():
    if norm(p) not in cat_paths:
        missing_paths.setdefault(p, [set(),set()])
        missing_paths[p][0].add(v); missing_paths[p][1] |= ds

# verb mismatch: path present but verb differs
verb_mismatch = []
for (v,p),ds in sorted(doc_routes.items()):
    n = norm(p)
    if n in cat_paths and v != "?" and v not in cat_paths[n]:
        verb_mismatch.append((v,p,sorted(cat_paths[n]),sorted(ds)))

# ---------------- DATA OBJECTS with alias map ----------------
ALIAS = {  # spec object -> table that genuinely covers it (verified by reading the DDL)
 "Customer":"contacts","Vendor":"contacts","CustomerReceipt":"payments","VendorPayment":"payments",
 "ReceiptAllocation":"payment_allocations","MatchCandidate":"bank_matches",
 "ReconciliationMatch":"bank_matches","ReconciliationSession":"bank_reconciliations",
 "Location":"warehouse_locations","FinancialStatementSnapshot":"financial_snapshots",
 "CurrencyRevaluationRun":"fx_remeasurement_runs","Group":"consolidation_groups",
 "GroupMembership":"consolidation_group_entities","AccountMapping":"consolidation_account_mappings",
 "MigrationProject":"migration_jobs","Department":"dimension_values","CostCenter":"dimension_values",
 "WorkflowDefinition":"approval_workflows","WorkflowVersion":"approval_workflows",
 "WorkflowInstance":"approval_requests","ApprovalDecision":"approval_steps",
 "DepreciationSchedule":"depreciation_schedule_lines","BudgetVersion":"budgets",
 "PostingRule":"posting_rule_versions","CloseChecklist":"close_runs",
 "GoodsReceipt":"inventory_documents","StockAdjustment":"inventory_documents",
 "StockCount":"inventory_documents","Shipment":"inventory_documents",
 "DocumentExtraction":"ai_decisions","CodingSuggestion":"ai_decisions",
 "MatchSuggestion":"ai_decisions","AgentAction":"ai_decisions",
 "BillLine":"vendor_bill_lines",
}
# Objects the spec itself declares as deliberately non-persistent / derived
DERIVED = {"LedgerBalanceReadModel","InventoryValuation","AccountingEvent","ReversalLink",
           "Permission","UserRoleScope","Currency"}

doc_objects = {}
for num,(title,body) in sorted(docs.items()):
    blk = subsection(body,"Data objects")
    if not blk: continue
    flat = " ".join(blk.split()).rstrip(".")
    for obj in re.split(r",\s*|\s+and\s+", flat):
        obj = obj.strip(" .")
        if obj and re.match(r"^[A-Z][A-Za-z0-9/]*$", obj):
            doc_objects.setdefault(obj,set()).add(num)

def snake(n): return re.sub(r"(?<!^)(?=[A-Z])","_",n).lower()
def plural(s):
    if s.endswith("y") and not s.endswith(("ay","ey","oy","uy")): return s[:-1]+"ies"
    if s.endswith(("s","x","z","ch","sh")): return s+"es"
    return s+"s"

DOC_PHASE = {"02":1,"03":2,"04":3,"05":3,"06":4,"07":3,"08":5,"09":5,"10":5,
             "11":7,"12":6,"13":8,"14":6,"15":9,"16":0,"17":9,"20":10,"23":1,"24":11}

covered, aliased, derived, absent = [],[],[],[]
for obj,nums in sorted(doc_objects.items()):
    ds = ",".join(sorted(nums))
    direct = ({snake(obj),plural(snake(obj))} & tables)
    if direct: covered.append((obj,ds,sorted(direct)[0]))
    elif obj in ALIAS and ALIAS[obj] in tables: aliased.append((obj,ds,ALIAS[obj]))
    elif obj in DERIVED: derived.append((obj,ds))
    else:
        ph = min((DOC_PHASE.get(n,99) for n in nums), default=99)
        absent.append((obj,ds,ph))

b=io.StringIO(); w=b.write
w("=== ROUTES ===\n")
w(f"catalog entries={len(cat)}  distinct catalog paths={len(cat_paths)}  doc (verb,path) pairs={len(doc_routes)}\n")
w(f"\n-- doc paths ABSENT from catalog ({len(missing_paths)}) --\n")
for p,(vs,ds) in sorted(missing_paths.items()):
    w(f"{'/'.join(sorted(vs)):10} {p:50} [doc {','.join(sorted(ds))}]\n")
w(f"\n-- verb mismatches ({len(verb_mismatch)}) --\n")
for v,p,cv,ds in verb_mismatch: w(f"doc {v:6} {p:44} catalog has {cv}  [doc {','.join(ds)}]\n")

w(f"\n=== DATA OBJECTS: {len(doc_objects)} spec'd ===\n")
w(f"direct table match : {len(covered)}\n")
w(f"aliased (verified) : {len(aliased)}\n")
w(f"derived/non-persist: {len(derived)}\n")
w(f"GENUINELY ABSENT   : {len(absent)}\n")
w("\n-- aliased --\n")
for o,d,t in aliased: w(f"  {o:34} -> {t}\n")
w("\n-- derived --\n")
for o,d in derived: w(f"  {o:34} doc{d}\n")
w("\n-- ABSENT, grouped by earliest phase --\n")
byph={}
for o,d,p in absent: byph.setdefault(p,[]).append((o,d))
for p in sorted(byph):
    w(f"\n  PHASE {p}  ({len(byph[p])} objects)\n")
    for o,d in sorted(byph[p]): w(f"    {o:38} doc{d}\n")
w("\n-- table count needed per phase (absent objects, rough 1:1) --\n")
for p in sorted(byph): w(f"  phase {p}: +{len(byph[p])}\n")
w(f"\nexisting tables in blueprint: {len(tables)}\n")
w(f"projected additional        : {len(absent)}\n")
w(f"projected total             : ~{len(tables)+len(absent)}\n")

o=b.getvalue()
open(os.path.join(OUT,"extract2_report.txt"),"w",encoding="utf-8").write(o)
print(o)
