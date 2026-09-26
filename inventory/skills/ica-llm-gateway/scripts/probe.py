#!/usr/bin/env python3
"""Probe the ICA gateway and record what this key can use.

Writes to $ICA_LLM_DIR (default ~/.ica-llm), never into a repo:
  catalog/YYYY-MM-DD.json  model ids from GET /models
  probes/YYYY-MM-DD.json   per-model results; later runs the same day merge in
  SUMMARY.md               latest catalog diff + probe table, regenerated every run

Reads ICA_API_KEY and ICA_BASE_API_URL. The key is never written or printed.
Results depend on the key's team entitlements, so they describe this machine's key,
not the gateway in general.
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA = 'ica-llm-probe/0.2'
EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh']
TOOL = [{'type': 'function', 'function': {'name': 'lookup_word', 'description': 'Look up a word',
         'parameters': {'type': 'object', 'properties': {'word': {'type': 'string'}}, 'required': ['word']}}}]

BASE = os.environ.get('ICA_BASE_API_URL', '').rstrip('/')
KEY = os.environ.get('ICA_API_KEY', '')


def snippet(text):
    """Short, single-line, key-free error text."""
    text = re.sub(r'\s+', ' ', str(text))
    if KEY:
        text = text.replace(KEY, '<key>')
    return text[:160]


def post(path, body, anthropic=False, tries=3):
    headers = {'Content-Type': 'application/json', 'User-Agent': UA}
    if anthropic:
        headers.update({'x-api-key': KEY, 'anthropic-version': '2023-06-01'})
    else:
        headers['Authorization'] = f'Bearer {KEY}'
    for n in range(tries):
        try:
            req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            txt = e.read().decode(errors='replace')
            # Connection-slot exhaustion is a transient 401, not a bad key.
            if e.code == 401 and 'connection slots' in txt and n < tries - 1:
                time.sleep(2 * (n + 1))
                continue
            return e.code, snippet(txt)
        except Exception as e:  # network / timeout
            if n < tries - 1:
                time.sleep(2 * (n + 1))
                continue
            return 0, snippet(repr(e))


def chat(model, **extra):
    body = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with exactly: pong'}], **extra}
    return post('/chat/completions', body)


def probe_text(model):
    status, r = chat(model, max_tokens=32)
    if status != 200:
        return f'error {status}: {r}'
    choice = r['choices'][0]
    if 'pong' in (choice['message'].get('content') or '').lower():
        return 'ok'
    # Reasoning models can spend a small budget before emitting text.
    status, r = chat(model, max_tokens=4000)
    if status == 200 and 'pong' in (r['choices'][0]['message'].get('content') or '').lower():
        return f"ok (needs budget: {r.get('usage', {}).get('completion_tokens')} completion tokens)"
    return f"no text (finish_reason={choice.get('finish_reason')})"


def probe_temperature0(model):
    status, r = chat(model, max_tokens=4000, temperature=0)
    return 'ok' if status == 200 else f'rejected {status}: {r}'


def probe_tools(model, effort=None):
    body = {'model': model, 'max_tokens': 4000, 'tools': TOOL,
            'messages': [{'role': 'user', 'content': "Look up the word 'gato'."}]}
    if effort:
        body['reasoning_effort'] = effort
    status, r = post('/chat/completions', body)
    if status != 200:
        return f'error {status}: {r}'
    calls = r['choices'][0]['message'].get('tool_calls') or []
    if calls and 'gato' in calls[0]['function'].get('arguments', '').lower():
        return 'ok'
    return f"no tool call (finish_reason={r['choices'][0].get('finish_reason')})"


def probe_messages(model):
    body = {'model': model, 'max_tokens': 32, 'messages': [{'role': 'user', 'content': 'Reply with exactly: pong'}]}
    status, r = post('/messages', body, anthropic=True)
    if status != 200:
        return f'error {status}: {r}'
    return 'ok' if 'pong' in ''.join(b.get('text', '') for b in r.get('content', [])).lower() else 'no text'


def probe_effort(model):
    # A value is accepted when the request returns 200, whether or not a tool gets called:
    # tool support is the separate `tools` check.
    accepted, rejected = [], {}
    for e in EFFORTS:
        outcome = probe_tools(model, e)
        if outcome.startswith('error'):
            rejected[e] = outcome
        else:
            accepted.append(e)
    return {'accepted': accepted, 'rejected': rejected}


def probe_model(model, effort):
    result = {'probed_at': dt.datetime.now().isoformat(timespec='seconds'),
              'text': probe_text(model), 'temperature0': probe_temperature0(model), 'tools': probe_tools(model)}
    if model.startswith('claude-'):
        result['messages'] = probe_messages(model)
    if effort:
        result['effort_with_tools'] = probe_effort(model)
    return model, result


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


def fetch_catalog():
    req = urllib.request.Request(BASE + '/models', headers={'Authorization': f'Bearer {KEY}', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return sorted(m['id'] for m in json.load(r)['data'])


REASONS = (('team not allowed', 'team not allowed'), ('UnsupportedParamsError', 'proxy rule'),
           ('OpenAIException', 'upstream'), ('Invalid reasoning effort', 'invalid value'))


def short(outcome):
    """One-cell label; the full error text stays in the JSON."""
    if not outcome.startswith(('error', 'rejected')):
        return outcome
    code = (re.search(r'\b\d{3}\b', outcome) or [None])[0] or 'network'
    label = next((name for needle, name in REASONS if needle in outcome), '')
    return f'{code} {label}'.strip()


def effort_cell(eff):
    if not eff:
        return 'not probed'
    reasons = '; '.join(sorted({short(v) for v in eff['rejected'].values()}))
    if not eff['accepted']:
        return f'rejects all ({reasons})'
    cell = 'accepts ' + ', '.join(eff['accepted'])
    return cell + (f"; rejects {', '.join(eff['rejected'])} ({reasons})" if eff['rejected'] else '')


def summary(root, catalogs, probes):
    latest = json.loads(catalogs[-1].read_text())
    lines = ['# ICA probe summary', '',
             f'Generated by the `ica-llm-gateway` skill\'s `scripts/probe.py`. Do not hand-edit; re-run the script.', '',
             f"Host `{latest['host']}`. Catalog {catalogs[-1].stem}: **{latest['count']} models**."]
    if len(catalogs) > 1:
        prev = json.loads(catalogs[-2].read_text())
        added = sorted(set(latest['ids']) - set(prev['ids']))
        removed = sorted(set(prev['ids']) - set(latest['ids']))
        lines.append(f"Since {catalogs[-2].stem} ({prev['count']}): added {added or 'none'}, removed {removed or 'none'}.")
    lines += ['', '| Model | Text | `temperature=0` | Tools | `reasoning_effort` with tools | `/v1/messages` | Probed |',
              '|---|---|---|---|---|---|---|']
    for model in sorted(probes):
        p = probes[model]
        note = '' if model in latest['ids'] else ' *(not in catalog)*'
        cells = [short(p['text']), short(p['temperature0']), short(p['tools']), effort_cell(p.get('effort_with_tools')),
                 short(p.get('messages', '—')), p['probed_at'][:10]]
        lines.append(f"| `{model}`{note} | " + ' | '.join(cells) + ' |')
    lines += ['', '"not probed" means the check was not run, not that it failed. `proxy rule` is a LiteLLM',
              'rejection; `upstream` is a vendor error relayed by LiteLLM, which also applies at the vendor\'s',
              'direct API. Full error text is in `probes/<date>.json`.', '']
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--models', help='comma-separated ids to probe (default: every catalog id)')
    ap.add_argument('--extra-ids', default='', help='comma-separated ids not in the catalog, e.g. a client default')
    ap.add_argument('--effort', action='store_true', help='also probe reasoning_effort values with tools')
    ap.add_argument('--catalog-only', action='store_true')
    ap.add_argument('--workers', type=int, default=3)
    args = ap.parse_args()
    if not (BASE and KEY):
        sys.exit('ICA_API_KEY and ICA_BASE_API_URL must be set')

    root = Path(os.environ.get('ICA_LLM_DIR', Path.home() / '.ica-llm'))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    today = dt.date.today().isoformat()

    ids = fetch_catalog()
    write_private(root / 'catalog' / f'{today}.json',
                  json.dumps({'host': BASE, 'fetched_at': dt.datetime.now().isoformat(timespec='seconds'),
                              'count': len(ids), 'ids': ids}, indent=1) + '\n')
    print(f'catalog: {len(ids)} models')

    probe_file = root / 'probes' / f'{today}.json'
    probes = json.loads(probe_file.read_text()) if probe_file.exists() else {}
    if not args.catalog_only:
        targets = args.models.split(',') if args.models else ids
        targets += [i for i in args.extra_ids.split(',') if i]
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for model, result in ex.map(lambda m: probe_model(m, args.effort), targets):
                probes[model] = result
                print(f"  {model}: text={result['text'][:24]} tools={result['tools'][:24]}")
        write_private(probe_file, json.dumps(probes, indent=1, sort_keys=True) + '\n')

    catalogs = sorted((root / 'catalog').glob('*.json'))
    write_private(root / 'SUMMARY.md', summary(root, catalogs, probes))
    print(f'wrote {root}/SUMMARY.md')


if __name__ == '__main__':
    main()
