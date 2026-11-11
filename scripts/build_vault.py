"""Build data/vault.json from CUAD v1 (510 real EDGAR contracts, labels by lawyers; CC BY 4.0).

  curl -L https://github.com/TheAtticusProject/cuad/raw/main/data.zip -o cuad.zip && unzip cuad.zip -d cuad
  python3 scripts/build_vault.py cuad/CUADv1.json

The "AI extraction" is a stand-in I can run for free: a clause classifier (logistic regression
over hashed unigrams+bigrams, AdaGrad, class-weighted, scored per clause, max over clauses, no
recalibration) trained with 5-fold cross-fitting by contract, so every contract's prediction comes
from models that never saw it. Its mistakes are real. The CUAD lawyer annotation is the ground truth
the verifying lawyer would enter.
"""
import json, re, sys, zlib
import numpy as np

COLUMNS = [
    ("Uncapped Liability", "uncapped_liability", "Uncapped liability"),
    ("Cap On Liability", "cap_on_liability", "Liability cap"),
    ("Termination For Convenience", "termination_for_convenience", "Termination for convenience"),
    ("Change Of Control", "change_of_control", "Change of control"),
    ("Non-Compete", "non_compete", "Non-compete"),
    ("Exclusivity", "exclusivity", "Exclusivity"),
    ("Audit Rights", "audit_rights", "Audit rights"),
    ("Most Favored Nation", "most_favored_nation", "Most favored nation"),
]
H = 1 << 18
SEED = 20261111

def chunks(text):
    # clause-ish units: split on newlines and sentence ends, merge tiny pieces
    parts, out, pos = re.split(r'(\n+|(?<=[.;])\s+(?=[A-Z(\d]))', text), [], 0
    buf, start = "", 0
    for p in parts:
        if p is None: continue
        if not buf: start = pos
        buf += p; pos += len(p)
        if len(buf.strip()) >= 80 or re.fullmatch(r'\n+', p or ''):
            if buf.strip(): out.append((start, pos, buf))
            buf = ""
    if buf.strip(): out.append((start, pos, buf))
    return out

def feats(s):
    toks = re.findall(r"[a-z]+", s.lower())
    f = {zlib.crc32(t.encode()) % H for t in toks}
    f |= {zlib.crc32((a + " " + b).encode()) % H for a, b in zip(toks, toks[1:])}
    return np.fromiter(f, dtype=np.int64)


SUFFIX = ["CORPORATION", "HOLDINGS", "TECHNOLOGIES", "TECHNOLOGY", "THERAPEUTICS", "PHARMACEUTICALS", "FINANCIAL", "INTERNATIONAL",
          "SERVICES", "SYSTEMS", "SOLUTIONS", "NETWORKS", "ENERGY", "GROUP", "BANCORP", "MEDICAL", "HEALTH", "BRANDS", "PARTNERS",
          "INC", "CORP", "LLC", "LTD", "PLC", "LP", "CO", "SA", "AG", "NV"]
def split_company(c):
    c = c.replace(",", " ").strip()
    if re.search(r"[a-z]", c):  # CamelCase
        return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", c).strip()
    words = []
    while True:
        for suf in SUFFIX:
            if c.endswith(suf) and len(c) > len(suf) + 2:
                words.insert(0, suf); c = c[: -len(suf)].strip(); break
        else:
            break
    words.insert(0, c)
    small = {"INC": "Inc", "CORP": "Corp", "LLC": "LLC", "LTD": "Ltd", "PLC": "plc", "LP": "LP", "CO": "Co", "SA": "SA", "AG": "AG", "NV": "NV"}
    return " ".join(small.get(w, w.title()) for w in words if w)
def parse_title(t):
    m = re.match(r"(.+?)_(\d{1,2})_(\d{1,2})_(\d{4})-(.+)", t)
    if m:
        rest = m.group(5).split("-")
        kind = next((x for x in reversed(rest) if re.search(r"[A-Za-z]{4}", x) and not x.startswith("EX")), rest[-1])
        kind = re.split(r"\s+between\s+|_", kind, flags=re.I)[0].strip().title()[:60]
        return {"title": t, "company": split_company(m.group(1).replace("_", " ")), "year": int(m.group(4)), "kind": kind}
    m = re.match(r"(.+?)_(\d{4})\d{4}_[^_]+_EX-[^_]+_\d+_EX-[^_]+_(.+)", t)
    if m:
        return {"title": t, "company": split_company(m.group(1)), "year": int(m.group(2)), "kind": re.sub(r"\d+$", "", m.group(3)).strip()}
    m = re.match(r"(.+?)\s+-\s+(.+)", t)
    if m:
        return {"title": t, "company": m.group(1).strip().title().replace("Inc.", "Inc."), "year": None, "kind": m.group(2).strip()}
    return {"title": t, "company": t, "year": None, "kind": ""}

def main(path):
    data = json.load(open(path))["data"]
    docs = []
    for d in data:
        text = d["paragraphs"][0]["context"]
        spans = {}
        for qa in d["paragraphs"][0]["qas"]:
            m = re.search(r'related to "([^"]+)"', qa["question"])
            if m: spans[m.group(1)] = [(a["answer_start"], a["answer_start"] + len(a["text"]), a["text"]) for a in qa["answers"]]
        ch = chunks(text)
        docs.append({"title": d["title"], "text": text, "chunks": ch, "spans": spans, "F": [feats(c[2]) for c in ch]})
    rng = np.random.default_rng(SEED)
    fold = rng.permutation(len(docs)) % 5
    # CSR layout of every clause's hashed features
    lens = np.array([len(f) for d in docs for f in d["F"]])
    idx = np.concatenate([f for d in docs for f in d["F"]])
    docof = np.concatenate([[i] * len(d["F"]) for i, d in enumerate(docs)])
    out_cols = {}
    for cat, key, label in COLUMNS:
        y_doc = np.array([1 if docs[i]["spans"].get(cat) else 0 for i in range(len(docs))])
        ych = np.concatenate([[1 if any(s < e2 and s2 < e for s2, e2, _ in (d["spans"].get(cat) or [])) else 0 for (s, e, _) in d["chunks"]] for d in docs])
        score = np.zeros(len(docs)); best = np.zeros(len(docs), dtype=int)
        # stage 1: clause-level logistic regression (AdaGrad, class-weighted, L2), 5-fold cross-fit by contract
        for k in range(5):
            trm = fold[docof] != k
            idx_tr = idx[np.repeat(trm, lens)]; l_tr = lens[trm]; ptr = np.concatenate([[0], np.cumsum(l_tr)])[:-1]
            y_tr = ych[trm]; sw = np.where(y_tr == 1, np.sqrt((len(y_tr) - y_tr.sum()) / max(1, y_tr.sum())), 1.0)
            w = np.zeros(H); b = -3.0; G = np.full(H, 1e-8)
            for _ in range(120):
                z = np.add.reduceat(w[idx_tr], ptr) + b
                res = (1 / (1 + np.exp(-z)) - y_tr) * sw
                g = np.bincount(idx_tr, weights=np.repeat(res, l_tr), minlength=H) / len(y_tr) + 1e-5 * w
                G += g * g; w -= 0.5 * g / np.sqrt(G); b -= 0.5 * res.mean()
            tem = ~trm; idx_te = idx[np.repeat(tem, lens)]; l_te = lens[tem]; ptr_te = np.concatenate([[0], np.cumsum(l_te)])[:-1]
            zte = np.add.reduceat(w[idx_te], ptr_te) + b; dte = docof[tem]
            for i in np.unique(dte):
                zz = zte[dte == i]; j = int(zz.argmax()); score[i] = zz[j]; best[i] = j
        # No tenant-specific calibration: like an LLM extractor's confidence, the probability is the
        # model's own (class-weighted, so systematically overconfident on "present"). The verified
        # count must not depend on it being calibrated.
        prob = 1 / (1 + np.exp(-score))
        cells = []
        for i, d in enumerate(docs):
            cs, ce, ctext = d["chunks"][best[i]]
            sp = d["spans"].get(cat) or []
            cells.append({"p": round(float(prob[i]), 4), "y": int(y_doc[i]),
                          "q": re.sub(r"\s+", " ", ctext).strip()[:240],
                          "t": re.sub(r"\s+", " ", sp[0][2]).strip()[:240] if sp else ""})
        acc = float(((prob >= 0.5) == (y_doc == 1)).mean())
        out_cols[key] = {"label": label, "cuad": cat, "cells": cells}
        print(f"{label:28s} truth {y_doc.sum():4d}  ai>=0.5 {(prob >= 0.5).sum():4d}  sum p {prob.sum():7.1f}  acc {acc:.3f}")
    meta = [parse_title(d["title"]) for d in docs]
    json.dump({"source": "CUAD v1 (The Atticus Project, CC BY 4.0): 510 commercial contracts from SEC EDGAR with lawyer annotations",
               "seed": SEED, "docs": meta, "columns": out_cols}, open("data/vault.json", "w"), separators=(",", ":"))

if __name__ == "__main__":
    main(sys.argv[1])
