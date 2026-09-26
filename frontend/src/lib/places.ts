// Collapses a raw geocoder label into a short display form, e.g.
// "Chico, Chico, California" -> "Chico, CA". Mirrors format_place() in
// backend/app/domain.py (used by the admin destination insights) so the
// same place reads the same way everywhere.

const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
}

const COUNTRY_NAMES = new Set(['united states', 'united states of america', 'usa', 'us'])

export function formatPlace(label: string | null | undefined): string {
  if (!label) return ''
  const parts: string[] = []
  const seen = new Set<string>()
  for (const raw of label.split(',')) {
    const part = raw.trim()
    const key = part.toLowerCase()
    if (!part || seen.has(key) || COUNTRY_NAMES.has(key) || key.endsWith(' county') || /^\d[\d-]*$/.test(part)) continue
    seen.add(key)
    parts.push(US_STATE_ABBREVIATIONS[key] ?? part)
  }
  if (parts.length === 0) return label.trim()
  return (parts.length > 3 ? [parts[0], ...parts.slice(-2)] : parts).join(', ')
}
