import type { Crest, CrestIcon } from '../sim/team';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
let uid = 0;

// All drawing happens in a 100 × 120 box.
const SHAPES: Record<Crest['shape'], string> = {
  shield: '<path d="M10 8 H90 V60 C90 92 50 113 50 113 C50 113 10 92 10 60 Z"/>',
  pointed: '<path d="M50 5 L93 21 V61 C93 90 50 114 50 114 C50 114 7 90 7 61 V21 Z"/>',
  round: '<circle cx="50" cy="60" r="46"/>',
  hex: '<polygon points="50,7 94,32 94,88 50,113 6,88 6,32"/>',
};

function pattern(c: Crest): string {
  const [a, b] = c.colors.map(hex);
  const base = `<rect x="0" y="0" width="100" height="120" fill="${a}"/>`;
  switch (c.pattern) {
    case 'stripes':
      return base + [16, 40, 64, 88].map((x) => `<rect x="${x - 6}" y="0" width="12" height="120" fill="${b}"/>`).join('');
    case 'halves':
      return base + `<rect x="50" y="0" width="50" height="120" fill="${b}"/>`;
    case 'chevron':
      return base + `<polygon points="0,62 50,92 100,62 100,80 50,110 0,80" fill="${b}"/>`;
    case 'sash':
      return base + `<polygon points="0,10 14,0 100,96 100,120 86,120 0,26" fill="${b}"/>`;
    case 'quarters':
      return base + `<rect x="50" y="0" width="50" height="60" fill="${b}"/><rect x="0" y="60" width="50" height="60" fill="${b}"/>`;
    default:
      return base;
  }
}

function icon(kind: CrestIcon, col: string): string {
  const s = `stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const f = `fill="${col}"`;
  switch (kind) {
    case 'star': {
      const pts = Array.from({ length: 10 }, (_, i) => {
        const r = i % 2 ? 9 : 21, a = -Math.PI / 2 + (i * Math.PI) / 5;
        return `${(50 + Math.cos(a) * r).toFixed(1)},${(50 + Math.sin(a) * r).toFixed(1)}`;
      }).join(' ');
      return `<polygon points="${pts}" ${f}/>`;
    }
    case 'crown':
      return `<path d="M30 62 L27 38 L39 49 L50 31 L61 49 L73 38 L70 62 Z" ${f}/><rect x="30" y="64" width="40" height="6" rx="2" ${f}/>`;
    case 'wave':
      return `<path d="M26 44 q6 -8 12 0 t12 0 t12 0 t12 0" ${s}/><path d="M26 58 q6 -8 12 0 t12 0 t12 0 t12 0" ${s}/>`;
    case 'tower':
      return `<path d="M38 70 V40 H62 V70 Z M35 40 V30 H42 V35 H47 V30 H53 V35 H58 V30 H65 V40 Z" ${f}/><rect x="46" y="56" width="8" height="14" fill="#0006"/>`;
    case 'bolt':
      return `<polygon points="56,26 34,55 47,55 42,76 66,45 53,45 60,26" ${f}/>`;
    case 'tree':
      return `<polygon points="50,24 33,48 67,48" ${f}/><polygon points="50,36 28,62 72,62" ${f}/><rect x="46" y="62" width="8" height="10" ${f}/>`;
    case 'sun':
      return `<circle cx="50" cy="50" r="10" ${f}/>` + Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return `<line x1="${50 + Math.cos(a) * 15}" y1="${50 + Math.sin(a) * 15}" x2="${50 + Math.cos(a) * 22}" y2="${50 + Math.sin(a) * 22}" ${s}/>`;
      }).join('');
    case 'anchor':
      return `<circle cx="50" cy="30" r="5" ${s}/><line x1="50" y1="35" x2="50" y2="72" ${s}/><line x1="40" y1="44" x2="60" y2="44" ${s}/><path d="M32 58 Q50 80 68 58" ${s}/>`;
    case 'key':
      return `<circle cx="38" cy="50" r="9" ${s}/><line x1="47" y1="50" x2="72" y2="50" ${s}/><line x1="64" y1="50" x2="64" y2="58" ${s}/><line x1="71" y1="50" x2="71" y2="57" ${s}/>`;
    case 'ball':
      return `<circle cx="50" cy="50" r="19" ${s}/><polygon points="50,42 58,48 55,57 45,57 42,48" ${f}/>`;
    case 'bird':
      return `<path d="M27 52 Q39 36 50 49 Q61 36 73 52 Q61 45 50 58 Q39 45 27 52 Z" ${f}/>`;
    case 'mountain':
      return `<polygon points="26,68 44,38 52,50 60,34 76,68" ${f}/><polygon points="44,38 39,46 49,46" fill="#fff8"/>`;
  }
}

/** Original club badge as an inline SVG string. */
export function crestSvg(c: Crest, size = 64): string {
  const id = `cr${++uid}`;
  const [fieldC, , trimC] = c.colors.map(hex);
  // Initials sit on a ribbon in the trim colour; text uses the field colour.
  const band = `<rect x="0" y="80" width="100" height="18" fill="${trimC}"/>
    <text x="50" y="94" text-anchor="middle" font-family="'Arial Black', Impact, sans-serif" font-weight="900" font-size="14" fill="${fieldC}" letter-spacing="1">${c.initials}</text>`;
  // A disc behind the icon keeps it readable on striped or split fields.
  const disc = c.pattern === 'plain' ? '' : `<circle cx="50" cy="50" r="27" fill="${fieldC}" stroke="${trimC}" stroke-width="2.5"/>`;
  return `<svg class="crest" width="${size}" height="${size * 1.2}" viewBox="0 0 100 120" role="img" aria-label="${c.initials} 엠블럼">
    <defs><clipPath id="${id}">${SHAPES[c.shape]}</clipPath></defs>
    <g clip-path="url(#${id})">${pattern(c)}${disc}${icon(c.icon, trimC)}${band}</g>
    <g fill="none" stroke="${trimC}" stroke-width="5">${SHAPES[c.shape]}</g>
    <g fill="none" stroke="#0005" stroke-width="1.5" transform="translate(50 60) scale(0.9) translate(-50 -60)">${SHAPES[c.shape]}</g>
  </svg>`;
}
