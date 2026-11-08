"""Polyline decoding and point-to-route distance helpers."""
import math


def decode_polyline(s: str):
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lng += d
        pts.append((lat / 1e5, lng / 1e5))
    return pts


def haversine(a, b):
    r = 6371000.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class Route:
    def __init__(self, pts):
        self.pts = pts
        self.cum = [0.0]
        for k in range(1, len(pts)):
            self.cum.append(self.cum[-1] + haversine(pts[k - 1], pts[k]))

    def locate(self, p):
        """Return (distance along route from start to nearest point, distance off route) in metres."""
        best_off, best_along = float("inf"), 0.0
        lat0 = math.radians(p[0])
        kx = 111320.0 * math.cos(lat0)
        ky = 110540.0
        px, py = p[1] * kx, p[0] * ky
        for k in range(1, len(self.pts)):
            a, b = self.pts[k - 1], self.pts[k]
            ax, ay = a[1] * kx, a[0] * ky
            bx, by = b[1] * kx, b[0] * ky
            dx, dy = bx - ax, by - ay
            seg2 = dx * dx + dy * dy
            t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
            cx, cy = ax + t * dx, ay + t * dy
            off = math.hypot(px - cx, py - cy)
            if off < best_off:
                best_off = off
                best_along = self.cum[k - 1] + t * (self.cum[k] - self.cum[k - 1])
        if len(self.pts) == 1:
            best_off = haversine(p, self.pts[0])
        return best_along, best_off
