// 탑승 핀을 옮겼을 때 실제 도로 경로를 받아 주는 Netlify 함수예요.
// REST 키는 코드에 넣지 않고 Netlify 환경 변수 KAKAO_REST_KEY에 넣어요. 응답에도 키는 담기지 않아요.
// GET /api/route?from=위도,경도&to=장소key (좌표는 소수 3자리까지)

const API = 'https://apis-navi.kakaomobility.com/v1/directions';
const HOME = { lat: 37.256, lon: 127.0665 }; // 페이지의 ROUTES_ORIGIN과 같아요
const MAX_FROM_KM = 1.2; // 탑승 핀 범위(1km)보다 조금 넓게 받아요
// 페이지의 PLACES와 같은 도착지만 받아요. 이 함수로 다른 경로를 받아 가지 못하게 하려는 거예요
const PLACES = {
  ajou: [37.2797, 127.0473], ytst: [37.251528, 127.071347], mpst: [37.245799, 127.057364], cmst: [37.259485, 127.078945],
  mtst: [37.253019, 127.040389], gjst: [37.2886, 127.0514], lake: [37.281433, 127.069243], cafe: [37.2528, 127.069],
  sdc: [37.2575, 127.051], khu: [37.2398, 127.0832],
};
const TOLERANCE_M = 6; // tools/fetch_routes.py와 같은 값이에요

// 좌표를 소수 3자리(약 100m)로 묶고 도착지를 정해 둬서 요청 종류를 수천 개로 제한하고, 같은 요청은 캐시로 처리해요
export const config = { path: '/api/route', rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] } };

function km(a, b) {
  const t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lon - a.lon) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function parseFrom(v) {
  const m = /^(\d{1,2}\.\d{1,3}),(\d{1,3}\.\d{1,3})$/.exec(v || '');
  if (!m) return null;
  const p = { lat: +m[1], lon: +m[2] };
  return km(p, HOME) <= MAX_FROM_KM ? p : null;
}

function parseTo(v) {
  if (!Object.prototype.hasOwnProperty.call(PLACES, v)) return null;
  const [lat, lon] = PLACES[v];
  return { lat, lon };
}

// Douglas-Peucker. 좌표는 [위도, 경도]
export function simplify(points, tol = TOLERANCE_M) {
  if (points.length < 3) return points;
  const cos0 = Math.cos((points[0][0] * Math.PI) / 180);
  const xy = (p) => [p[1] * 111320 * cos0, p[0] * 110540];
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b <= a + 1) continue;
    const [ax, ay] = xy(points[a]);
    const [bx, by] = xy(points[b]);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy(points[i]);
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function extract(body) {
  const route = body && body.routes && body.routes[0];
  if (!route || route.result_code !== 0) return null;
  const points = [];
  for (const section of route.sections || []) {
    for (const road of section.roads || []) {
      const v = road.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) {
        if (!Number.isFinite(v[i]) || !Number.isFinite(v[i + 1])) return null;
        const p = [+v[i + 1].toFixed(6), +v[i].toFixed(6)]; // vertexes는 경도, 위도 순서예요
        const last = points[points.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
      }
    }
  }
  const s = route.summary || {}, fare = s.fare || {};
  if (points.length < 2 || !(s.distance > 0) || !(s.duration > 0) || !(fare.taxi > 0)) return null;
  return { path: simplify(points), m: s.distance, s: s.duration, taxi: fare.taxi };
}

const reply = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

export default async (req) => {
  if (req.method !== 'GET') return reply(405, { error: 'method' });
  // 다른 사이트의 페이지가 이 함수를 쓰지 못하게 해요. 브라우저가 아닌 호출까지 막지는 못해서 지역 제한과 함께 써요
  const url = new URL(req.url);
  const from = req.headers.get('referer') || req.headers.get('origin') || '';
  const fetchSite = req.headers.get('sec-fetch-site');
  let sameSite = fetchSite === 'same-origin';
  if (!sameSite) { try { sameSite = new URL(from).origin === url.origin; } catch { sameSite = false; } }
  if (!sameSite) return reply(403, { error: 'origin' });

  const a = parseFrom(url.searchParams.get('from'));
  const b = parseTo(url.searchParams.get('to'));
  if (!a || !b) return reply(400, { error: 'point' });

  const key = process.env.KAKAO_REST_KEY;
  if (!key) return reply(503, { error: 'key' });

  const query = new URLSearchParams({ origin: `${a.lon},${a.lat}`, destination: `${b.lon},${b.lat}` });
  let res;
  try {
    res = await fetch(`${API}?${query}`, { headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(4000) });
  } catch {
    return reply(502, { error: 'upstream' });
  }
  if (!res.ok) return reply(502, { error: 'upstream', status: res.status }); // 카카오 응답 본문은 그대로 넘기지 않아요
  const route = extract(await res.json().catch(() => null));
  if (!route) return reply(502, { error: 'route' });
  return reply(200, route, { 'cache-control': 'public, max-age=86400', 'netlify-cdn-cache-control': 'public, s-maxage=604800' });
};
