import net from 'node:net';

export function isIpAllowed(clientIp: string, allowedIpsConfig: string): boolean {
  const trimmed = allowedIpsConfig.trim();
  if (!trimmed) {
    return true; // Empty allows all
  }

  // Normalize client IP (strip IPv6 prefix for IPv4 if present)
  let cleanIp = clientIp.trim();
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.substring(7);
  }

  const allowedList = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of allowedList) {
    let cleanEntry = entry;
    if (cleanEntry.startsWith('::ffff:')) {
      cleanEntry = cleanEntry.substring(7);
    }

    // Exact match
    if (cleanIp === cleanEntry) {
      return true;
    }

    // Localhost aliases
    if (
      (cleanIp === '127.0.0.1' || cleanIp === '::1') &&
      (cleanEntry === '127.0.0.1' || cleanEntry === '::1' || cleanEntry === 'localhost')
    ) {
      return true;
    }

    // CIDR match (IPv4)
    if (cleanEntry.includes('/')) {
      if (isIpInCidr(cleanIp, cleanEntry)) {
        return true;
      }
    }
  }

  return false;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);

    if (net.isIPv4(ip) && net.isIPv4(range)) {
      if (isNaN(bits) || bits < 0 || bits > 32) return false;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const ipNum = ipv4ToNumber(ip);
      const rangeNum = ipv4ToNumber(range);
      return (ipNum & mask) === (rangeNum & mask);
    }
  } catch {
    return false;
  }
  return false;
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}
