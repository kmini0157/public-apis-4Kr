# -*- coding: utf-8 -*-
"""README.md / GLOBAL_PUBLIC_APIS_KR.md 를 파싱해서
검색 가능한 단일 파일 API 탐색기(docs/index.html)를 생성합니다.

사용법:
  python scripts/build_explorer.py

입력:
  - README.md                  (한국 API, 3열 표: API | 설명 | 인증)
  - GLOBAL_PUBLIC_APIS_KR.md   (글로벌 API, 5열 표: API | 설명 | 인증 | HTTPS | CORS)
  - reports/link_health_report_*.json (최신 링크 상태, 있으면 병합)
  - scripts/explorer_template.html

출력:
  - docs/index.html (데이터가 내장된 단일 파일 → file:// 로 열어도 동작)
"""

import glob
import html
import json
import os
import re
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

LINK_RE = re.compile(r'\[([^\]]+)\]\((https?://[^\)\s]+)\)')
NO_AUTH_VALUES = {'', 'no', '✕', 'x', '없음', '-'}


def clean_cell(text):
  text = html.unescape(text).strip()
  text = re.sub(r'\s+', ' ', text)
  return text


def normalize_auth(raw):
  value = clean_cell(raw).strip('`')
  if value.lower() in NO_AUTH_VALUES:
    return 'No'
  return value


def is_separator_row(cells):
  return all(re.fullmatch(r':?-{2,}:?', c.strip()) for c in cells if c.strip())


def parse_table_rows(path):
  """마크다운을 순회하며 (카테고리, 셀 목록)을 돌려준다."""
  with open(path, 'r', encoding='utf-8') as f:
    lines = f.read().split('\n')

  category = ''
  for line in lines:
    if line.startswith('### '):
      category = clean_cell(re.sub(r'<[^>]+>', '', line[4:]))
      continue
    if not category or not line.startswith('|'):
      continue
    cells = [c.strip() for c in line.split('|')[1:-1]]
    if len(cells) < 3 or is_separator_row(cells):
      continue
    if cells[0] in ('API', 'api'):
      continue
    yield category, cells


def parse_kr(path):
  apis = []
  for category, cells in parse_table_rows(path):
    match = LINK_RE.search(cells[0])
    if not match:
      continue
    apis.append({
      'n': clean_cell(match.group(1)),
      'u': html.unescape(match.group(2)),
      'd': clean_cell(re.sub(r'<[^>]+>', '', cells[1])),
      'a': normalize_auth(cells[2]),
      'c': category,
      's': 'kr',
    })
  return apis


def parse_global(path):
  apis = []
  for category, cells in parse_table_rows(path):
    if len(cells) < 5:  # APILayer 홍보 표(3열) 등은 제외
      continue
    match = LINK_RE.search(cells[0])
    if not match:
      continue
    apis.append({
      'n': clean_cell(match.group(1)),
      'u': html.unescape(match.group(2)),
      'd': clean_cell(re.sub(r'<[^>]+>', '', cells[1])),
      'a': normalize_auth(cells[2]),
      'h': clean_cell(cells[3]),
      'x': clean_cell(cells[4]),
      'c': category,
      's': 'global',
    })
  return apis


def load_latest_health():
  """가장 최근 링크 상태 리포트를 (url -> 정상여부, 검사일) 로 반환."""
  reports = sorted(glob.glob(os.path.join(ROOT, 'reports', 'link_health_report_*.json')))
  if not reports:
    return {}, ''
  latest = reports[-1]
  with open(latest, 'r', encoding='utf-8') as f:
    data = json.load(f)
  status = {r['url']: bool(r.get('is_working')) for r in data.get('results', [])}
  checked_at = (data.get('generated_at') or '')[:10]
  return status, checked_at


def main():
  kr = parse_kr(os.path.join(ROOT, 'README.md'))
  gl = parse_global(os.path.join(ROOT, 'GLOBAL_PUBLIC_APIS_KR.md'))

  health, checked_at = load_latest_health()
  for api in kr:
    if api['u'] in health:
      api['ok'] = 1 if health[api['u']] else 0

  apis = kr + gl
  if not apis:
    print('❌ 파싱된 API가 없습니다. 파일 형식을 확인해주세요.')
    sys.exit(1)

  payload = {
    'generated': datetime.now().strftime('%Y-%m-%d'),
    'healthCheckedAt': checked_at,
    'apis': apis,
  }
  # </script> 로 스크립트 블록이 조기 종료되지 않도록 이스케이프
  data_json = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')

  template_path = os.path.join(ROOT, 'scripts', 'explorer_template.html')
  with open(template_path, 'r', encoding='utf-8') as f:
    template = f.read()

  output = template.replace('/*__API_DATA__*/null', data_json)

  out_dir = os.path.join(ROOT, 'docs')
  os.makedirs(out_dir, exist_ok=True)
  out_path = os.path.join(out_dir, 'index.html')
  with open(out_path, 'w', encoding='utf-8') as f:
    f.write(output)

  print(f'✅ 한국 API {len(kr)}개 + 글로벌 API {len(gl)}개 = 총 {len(apis)}개')
  if checked_at:
    print(f'🔗 링크 상태 리포트 반영: {checked_at} (매칭 {sum(1 for a in kr if "ok" in a)}개)')
  print(f'📄 생성 완료: {os.path.relpath(out_path, ROOT)}')


if __name__ == '__main__':
  main()
