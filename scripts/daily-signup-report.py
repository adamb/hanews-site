#!/usr/bin/env python3
"""Daily hanews.org signup report + KV cleanup.

Deletes unconfirmed pending records older than 48 hours and orphaned token keys,
then reports confirmed/pending counts.
Run from cron or manually. Credentials read from ~/.hermes/profiles/hanews/.env.
"""
import json, os, urllib.request, urllib.error, urllib.parse, sys
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

ENV_PATH = os.path.expanduser('~/.hermes/profiles/hanews/.env')
REPORT_DIR = os.path.expanduser('~/workspace')
CUTOFF_HOURS = 48


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k] = v
    return env


def cf_api(path, env, method='GET', data=None):
    url = f'https://api.cloudflare.com/client/v4{path}'
    headers = {'Authorization': f"Bearer {env['CLOUDFLARE_API_TOKEN']}"}
    if data is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def list_kv_keys(env):
    ns = env['CLOUDFLARE_KV_NAMESPACE_ID']
    acc = env['CLOUDFLARE_ACCOUNT_ID']
    keys = []
    cursor = None
    while True:
        path = f'/accounts/{acc}/storage/kv/namespaces/{ns}/keys?limit=1000'
        if cursor:
            path += f'&cursor={urllib.parse.quote(cursor)}'
        res = cf_api(path, env)
        keys.extend(res['result'])
        if not res['result_info'].get('cursor'):
            break
        cursor = res['result_info']['cursor']
    return keys


def fetch_value(key, env):
    ns = env['CLOUDFLARE_KV_NAMESPACE_ID']
    acc = env['CLOUDFLARE_ACCOUNT_ID']
    url = f'https://api.cloudflare.com/client/v4/accounts/{acc}/storage/kv/namespaces/{ns}/values/{urllib.parse.quote(key)}'
    req = urllib.request.Request(url, headers={'Authorization': f"Bearer {env['CLOUDFLARE_API_TOKEN']}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode('utf-8', errors='replace')
            try:
                return (key, json.loads(body))
            except json.JSONDecodeError:
                return (key, body)
    except urllib.error.HTTPError as e:
        return (key, {'error': e.code})


def parse_ts(val):
    if not isinstance(val, dict):
        return None
    for field in ['lastSent', 'last_sent', 'created', 'createdAt', 'timestamp', 'ts', 'confirmedAt']:
        if field in val and val[field]:
            try:
                return datetime.fromisoformat(str(val[field]).replace('Z', '+00:00'))
            except Exception:
                pass
    return None


def mask_email(key):
    if '@' not in key or key.startswith('token:'):
        return key
    local, domain = key.split('@', 1)
    return local[:2] + '***@' + domain


def main():
    env = load_env(ENV_PATH)
    required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_KV_NAMESPACE_ID']
    missing = [r for r in required if r not in env]
    if missing:
        print(f'Missing env vars: {missing}', file=sys.stderr)
        sys.exit(1)

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=CUTOFF_HOURS)
    one_day = now - timedelta(hours=24)
    two_days = now - timedelta(hours=48)

    keys = list_kv_keys(env)
    email_keys = [k['name'] for k in keys if '@' in k['name'] and not k['name'].startswith('token:')]
    token_keys = [k['name'] for k in keys if k['name'].startswith('token:')]
    rate_keys = [k['name'] for k in keys if k['name'].startswith('rl:') or k['name'].startswith('cap:')]

    # Fetch email values
    email_records = []
    with ThreadPoolExecutor(max_workers=30) as ex:
        futures = [ex.submit(fetch_value, k, env) for k in email_keys]
        for f in as_completed(futures):
            email_records.append(f.result())

    confirmed = []
    pending = []
    stale = []
    for key, val in email_records:
        if isinstance(val, dict) and val.get('confirmed') is True:
            confirmed.append({'key': key, 'name': val.get('name', ''), 'ts': parse_ts(val)})
        else:
            ts = parse_ts(val)
            rec = {'key': key, 'ts': ts, 'value': val}
            if not ts or ts <= cutoff:
                stale.append(rec)
            else:
                pending.append(rec)

    # Identify token keys to delete (orphaned or pointing to stale email)
    emails_existing = {k for k, _ in email_records}
    tokens_to_delete = []
    for tk in token_keys:
        _, email = fetch_value(tk, env)  # value is the email address
        if isinstance(email, str) and (email not in emails_existing):
            tokens_to_delete.append(tk)

    delete_keys = [r['key'] for r in stale] + tokens_to_delete

    # Execute deletions
    deleted_count = 0
    failed_count = 0
    if delete_keys:
        def delete_one(key):
            ns = env['CLOUDFLARE_KV_NAMESPACE_ID']
            acc = env['CLOUDFLARE_ACCOUNT_ID']
            url = f'https://api.cloudflare.com/client/v4/accounts/{acc}/storage/kv/namespaces/{ns}/values/{urllib.parse.quote(key)}'
            req = urllib.request.Request(url, headers={'Authorization': f"Bearer {env['CLOUDFLARE_API_TOKEN']}"}, method='DELETE')
            try:
                with urllib.request.urlopen(req, timeout=30):
                    return True
            except urllib.error.HTTPError:
                return False

        with ThreadPoolExecutor(max_workers=30) as ex:
            futures = [ex.submit(delete_one, k) for k in delete_keys]
            for ok in as_completed(futures):
                if ok.result():
                    deleted_count += 1
                else:
                    failed_count += 1

    # Age buckets for remaining pending
    pb = {'<24h': 0, '24-48h': 0, '>48h': 0}
    for p in pending:
        if not p['ts']:
            pb['>48h'] += 1
        elif p['ts'] > one_day:
            pb['<24h'] += 1
        elif p['ts'] > two_days:
            pb['24-48h'] += 1
        else:
            pb['>48h'] += 1

    report = {
        'date': now.strftime('%Y-%m-%d'),
        'time_utc': now.isoformat(),
        'summary': {
            'total_kv_keys_before': len(keys),
            'total_kv_keys_after': len(keys) - deleted_count,
            'confirmed': len(confirmed),
            'pending': len(pending),
            'pending_age': pb,
            'deleted_today': deleted_count,
            'delete_failed': failed_count,
            'rate_limit_keys': len(rate_keys),
        },
        'confirmed_emails': [f"{mask_email(c['key'])} ({c.get('name', '')})" for c in confirmed],
    }

    os.makedirs(REPORT_DIR, exist_ok=True)
    report_path = os.path.join(REPORT_DIR, f'hanews-signup-report-{now.strftime("%Y-%m-%d")}.json')
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2, default=str)

    # Also print human-readable summary
    print(f"hanews.org signup report — {report['date']}")
    print(f"  KV keys: {report['summary']['total_kv_keys_before']} before → {report['summary']['total_kv_keys_after']} after")
    print(f"  Confirmed subscribers: {report['summary']['confirmed']}")
    if report['confirmed_emails']:
        for ce in report['confirmed_emails']:
            print(f"    - {ce}")
    print(f"  Pending signups: {report['summary']['pending']}")
    print(f"    <24h: {pb['<24h']}, 24-48h: {pb['24-48h']}, >48h: {pb['>48h']}")
    print(f"  Deleted today: {report['summary']['deleted_today']} (failed: {report['summary']['delete_failed']})")
    print(f"  Rate-limit keys: {report['summary']['rate_limit_keys']}")
    print(f"  Report saved: {report_path}")


if __name__ == '__main__':
    main()
