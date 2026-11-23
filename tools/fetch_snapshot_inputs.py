"""Download the raw inputs for tools/snapshot.mjs into DIR (default: yesterday)."""
import datetime, gzip, json, sys, urllib.request
from zoneinfo import ZoneInfo
API = 'https://rata.digitraffic.fi/api/v1'
def get(path):
    req = urllib.request.Request(API + path, headers={'Digitraffic-User': 'rail-delay-intelligence-demo', 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
        return gzip.decompress(data) if r.headers.get('Content-Encoding') == 'gzip' else data
out = sys.argv[1]
days = int(sys.argv[2]) if len(sys.argv) > 2 else 1
now = datetime.datetime.now(ZoneInfo('Europe/Helsinki'))  # Finnish operating day
dates = [(now - datetime.timedelta(days=i)).strftime('%Y-%m-%d') for i in range(1, days + 1)]
for d in dates: open(f'{out}/trains-{d}.json', 'wb').write(get(f'/trains/{d}'))
open(f'{out}/today.json', 'wb').write(get(f'/trains/{now:%Y-%m-%d}'))
open(f'{out}/stations.json', 'wb').write(get('/metadata/stations'))
open(f'{out}/causes.json', 'wb').write(get('/metadata/detailed-cause-category-codes'))
open(f'{out}/live.json', 'wb').write(get('/train-locations.geojson/latest'))
json.dump({'dates': dates, 'generatedAt': now.isoformat(timespec='seconds')}, open(f'{out}/meta.json', 'w'))
