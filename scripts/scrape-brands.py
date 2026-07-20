#!/usr/bin/env python3
"""
Scrape real catalogue data for Cougar and Outfitters (shop.md Prompt 1).

Outfitters (cougar.com.pk's opposite number) runs a classic server-rendered
Shopify (Liquid) storefront, so the standard REST JSON endpoints work:
    GET /products.json?limit=250&page=N

Cougar runs on Shopify Hydrogen + Oxygen (a headless React storefront) —
confirmed live via response headers (`powered-by: Shopify, Oxygen, Hydrogen`)
and the fact that /products.json 404s and returns the app's own SPA shell,
not Shopify's JSON. Hydrogen apps have no Liquid engine, so the classic REST
endpoints simply don't exist on that domain. Instead we use Shopify's
Storefront GraphQL API directly, against the public storefront access token
Hydrogen embeds client-side in every page load (this is the token's intended
public/read-only use — it grants no admin or write access, just catalogue
reads, and is not a secret).

Both are rate-limited to 1 request/second and retry with backoff on 429/5xx.
Raw responses are cached under scripts/scraped/<brand>/ so re-runs don't
re-hit the live sites. Normalised output goes to
scripts/scraped/<brand>-catalog.json.
"""
import json
import os
import re
import sys
import time
from collections import Counter

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRAPED_DIR = os.path.join(SCRIPT_DIR, 'scraped')
UA = 'Mozilla/5.0 (compatible; MetroMatrixResearch/1.0; +academic FYP demo)'
RATE_LIMIT_S = 1.0

session = requests.Session()
session.headers.update({'User-Agent': UA})


def polite_get(url, **kwargs):
    for attempt in range(4):
        resp = session.get(url, timeout=20, **kwargs)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = RATE_LIMIT_S * (2 ** attempt)
            print(f'  [{resp.status_code}] retrying {url} in {wait:.1f}s...')
            time.sleep(wait)
            continue
        time.sleep(RATE_LIMIT_S)
        return resp
    return resp


def polite_post(url, **kwargs):
    for attempt in range(4):
        resp = session.post(url, timeout=20, **kwargs)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = RATE_LIMIT_S * (2 ** attempt)
            print(f'  [{resp.status_code}] retrying {url} in {wait:.1f}s...')
            time.sleep(wait)
            continue
        time.sleep(RATE_LIMIT_S)
        return resp
    return resp


def cache_path(brand, name):
    return os.path.join(SCRAPED_DIR, brand, name)


def load_cache(brand, name):
    p = cache_path(brand, name)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return None


def save_cache(brand, name, data):
    p = cache_path(brand, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        json.dump(data, f)


# ── Outfitters: classic REST ────────────────────────────────────────

OUTFITTERS_DOMAIN = 'https://outfitters.com.pk'

EXCLUDE_TAG_RE = re.compile(r'junior|boys?\b|girls?\b|\bkid', re.IGNORECASE)


def fetch_outfitters_products():
    cached = load_cache('outfitters', 'products_raw.json')
    if cached is not None:
        print(f'[outfitters] using cached products_raw.json ({len(cached)} products)')
        return cached

    all_products = []
    page = 1
    while True:
        url = f'{OUTFITTERS_DOMAIN}/products.json?limit=250&page={page}'
        print(f'[outfitters] GET {url}')
        resp = polite_get(url)
        if resp.status_code != 200:
            print(f'[outfitters] page {page} failed with {resp.status_code} — stopping')
            break
        data = resp.json()
        products = data.get('products', [])
        if not products:
            break
        all_products.extend(products)
        print(f'[outfitters]   +{len(products)} (total {len(all_products)})')
        if len(products) < 250 or page >= 6:  # cap crawl depth — we only need a curated sample
            break
        page += 1

    save_cache('outfitters', 'products_raw.json', all_products)
    return all_products


def normalise_outfitters(raw_products, target_count=30):
    """Pick a diverse, adult (non-junior), in-stock-leaning sample and map
    onto the shared normalised shape."""
    candidates = []
    for p in raw_products:
        tags = p.get('tags', [])
        if any(EXCLUDE_TAG_RE.search(t) for t in tags):
            continue
        if not p.get('variants'):
            continue
        candidates.append(p)

    # Spread across product_type buckets rather than taking them in feed order
    by_type = {}
    for p in candidates:
        by_type.setdefault(p['product_type'], []).append(p)

    picked = []
    type_names = list(by_type.keys())
    idx = 0
    while len(picked) < target_count and any(by_type.values()):
        t = type_names[idx % len(type_names)]
        if by_type[t]:
            picked.append(by_type[t].pop(0))
        idx += 1
        if idx > target_count * len(type_names):
            break

    normalised = []
    for p in picked:
        variants = []
        for v in p['variants']:
            variants.append({
                'sku': v.get('sku') or f"OTF-{p['id']}-{v['id']}",
                'size': v.get('option1'),
                'color': v.get('option2'),
                'price': float(v['price']),
                'compareAtPrice': float(v['compare_at_price']) if v.get('compare_at_price') else None,
                'available': bool(v.get('available', True)),
            })
        images = [img['src'] for img in p.get('images', [])]
        normalised.append({
            'source': 'real',
            'title': p['title'],
            'handle': p['handle'],
            'bodyHtml': p.get('body_html') or '',
            'productType': p.get('product_type') or 'Apparel',
            'tags': p.get('tags', []),
            'images': images,
            'variants': variants,
        })
    return normalised


# ── Cougar: Storefront GraphQL API (Hydrogen storefront) ────────────

COUGAR_SHOP_DOMAIN = 'cougar-online.myshopify.com'
COUGAR_STOREFRONT_TOKEN = 'e54ea3938e2e60a617437a59e6056013'
COUGAR_GRAPHQL_URL = f'https://{COUGAR_SHOP_DOMAIN}/api/2024-01/graphql.json'

PRODUCTS_QUERY = """
query Products($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        title
        handle
        descriptionHtml
        productType
        tags
        images(first: 3) { edges { node { url } } }
        variants(first: 10) {
          edges {
            node {
              sku
              availableForSale
              price { amount }
              compareAtPrice { amount }
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}
"""


def fetch_cougar_products(max_pages=6):
    cached = load_cache('cougar', 'products_raw.json')
    if cached is not None:
        print(f'[cougar] using cached products_raw.json ({len(cached)} products)')
        return cached

    all_products = []
    cursor = None
    for page_num in range(max_pages):
        variables = {'first': 50, 'after': cursor}
        print(f'[cougar] GraphQL page {page_num + 1} (cursor={cursor})')
        resp = polite_post(
            COUGAR_GRAPHQL_URL,
            headers={
                'Content-Type': 'application/json',
                'X-Shopify-Storefront-Access-Token': COUGAR_STOREFRONT_TOKEN,
            },
            json={'query': PRODUCTS_QUERY, 'variables': variables},
        )
        if resp.status_code != 200:
            print(f'[cougar] page {page_num + 1} failed with {resp.status_code} — stopping')
            break
        data = resp.json()
        if 'errors' in data:
            print(f'[cougar] GraphQL errors: {data["errors"]} — stopping')
            break
        block = data['data']['products']
        edges = block['edges']
        all_products.extend(e['node'] for e in edges)
        print(f'[cougar]   +{len(edges)} (total {len(all_products)})')
        if not block['pageInfo']['hasNextPage']:
            break
        cursor = block['pageInfo']['endCursor']

    save_cache('cougar', 'products_raw.json', all_products)
    return all_products


def normalise_cougar(raw_products, target_count=30):
    candidates = [p for p in raw_products if p.get('variants', {}).get('edges')]

    by_type = {}
    for p in candidates:
        by_type.setdefault(p['productType'] or 'Apparel', []).append(p)

    picked = []
    type_names = list(by_type.keys())
    idx = 0
    while len(picked) < target_count and any(by_type.values()):
        t = type_names[idx % len(type_names)]
        if by_type[t]:
            picked.append(by_type[t].pop(0))
        idx += 1
        if idx > target_count * max(len(type_names), 1):
            break

    normalised = []
    for p in picked:
        variants = []
        for ve in p['variants']['edges']:
            v = ve['node']
            opts = {o['name'].lower(): o['value'] for o in v.get('selectedOptions', [])}
            variants.append({
                'sku': v.get('sku') or f"CGR-{p['handle']}-{len(variants)}",
                'size': opts.get('size'),
                'color': opts.get('color'),
                'price': float(v['price']['amount']),
                'compareAtPrice': float(v['compareAtPrice']['amount']) if v.get('compareAtPrice') else None,
                'available': bool(v.get('availableForSale', True)),
            })
        images = [e['node']['url'] for e in p.get('images', {}).get('edges', [])]
        normalised.append({
            'source': 'real',
            'title': p['title'],
            'handle': p['handle'],
            'bodyHtml': p.get('descriptionHtml') or '',
            'productType': p.get('productType') or 'Apparel',
            'tags': p.get('tags', []),
            'images': images,
            'variants': variants,
        })
    return normalised


def main():
    print('=== Outfitters (classic REST) ===')
    raw_outfitters = fetch_outfitters_products()
    if not raw_outfitters:
        print('[outfitters] FAILED to fetch any products — this domain may have changed')
        cat_outfitters = []
    else:
        cat_outfitters = normalise_outfitters(raw_outfitters, target_count=30)
        types = Counter(p['productType'] for p in cat_outfitters)
        print(f'[outfitters] normalised {len(cat_outfitters)} products across types: {dict(types)}')

    print('\n=== Cougar (Storefront GraphQL, Hydrogen) ===')
    raw_cougar = fetch_cougar_products()
    if not raw_cougar:
        print('[cougar] FAILED to fetch any products via GraphQL — falling back to reference taxonomy required')
        cat_cougar = []
    else:
        cat_cougar = normalise_cougar(raw_cougar, target_count=30)
        types = Counter(p['productType'] for p in cat_cougar)
        print(f'[cougar] normalised {len(cat_cougar)} products across types: {dict(types)}')

    with open(os.path.join(SCRAPED_DIR, 'outfitters-catalog.json'), 'w') as f:
        json.dump(cat_outfitters, f, indent=2)
    with open(os.path.join(SCRAPED_DIR, 'cougar-catalog.json'), 'w') as f:
        json.dump(cat_cougar, f, indent=2)

    print(f'\nWrote scripts/scraped/outfitters-catalog.json ({len(cat_outfitters)} products)')
    print(f'Wrote scripts/scraped/cougar-catalog.json ({len(cat_cougar)} products)')

    if cat_outfitters:
        print('\n--- Sample Outfitters product ---')
        print(json.dumps(cat_outfitters[0], indent=2)[:800])
    if cat_cougar:
        print('\n--- Sample Cougar product ---')
        print(json.dumps(cat_cougar[0], indent=2)[:800])


if __name__ == '__main__':
    main()
