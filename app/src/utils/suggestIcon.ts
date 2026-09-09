// Best-guess emoji for a map marker based on its category/subcategory text,
// so a user typing "house" or "coffee shop" gets a matching icon without
// having to pick one by hand. More specific keywords are listed first since
// the first match wins (e.g. "coffee" before the generic "restaurant").
const ICON_RULES: Array<{ keywords: string[]; icon: string }> = [
  { keywords: ["coffee", "cafe", "café"], icon: "☕" },
  { keywords: ["pizza"], icon: "🍕" },
  { keywords: ["ice cream", "gelato"], icon: "🍦" },
  { keywords: ["bakery", "patisserie"], icon: "🥐" },
  { keywords: ["brewery", "winery", "vineyard", "distillery"], icon: "🍷" },
  { keywords: ["bar", "pub", "tavern", "nightclub"], icon: "🍺" },
  { keywords: ["restaurant", "diner", "eatery", "food", "dining", "bistro"], icon: "🍽️" },
  { keywords: ["grocery", "supermarket", "convenience store"], icon: "🛒" },
  { keywords: ["mall", "shopping", "retail", "boutique", "store", "shop"], icon: "🛍️" },
  { keywords: ["pharmacy", "drugstore"], icon: "💊" },
  { keywords: ["hospital", "clinic", "medical", "urgent care"], icon: "🏥" },
  { keywords: ["dentist"], icon: "🦷" },
  { keywords: ["vet", "veterinary"], icon: "🐾" },
  { keywords: ["gym", "fitness"], icon: "🏋️" },
  { keywords: ["pool", "swimming"], icon: "🏊" },
  { keywords: ["golf"], icon: "⛳" },
  { keywords: ["stadium", "arena", "sports"], icon: "🏟️" },
  { keywords: ["amusement park", "theme park"], icon: "🎢" },
  { keywords: ["zoo"], icon: "🦁" },
  { keywords: ["aquarium"], icon: "🐠" },
  { keywords: ["theater", "theatre", "cinema", "movie"], icon: "🎬" },
  { keywords: ["museum", "gallery"], icon: "🏛️" },
  { keywords: ["library"], icon: "📚" },
  { keywords: ["school", "university", "college", "campus"], icon: "🏫" },
  { keywords: ["church", "cathedral", "chapel"], icon: "⛪" },
  { keywords: ["mosque"], icon: "🕌" },
  { keywords: ["synagogue"], icon: "🕍" },
  { keywords: ["temple", "shrine"], icon: "🛕" },
  { keywords: ["castle", "palace"], icon: "🏰" },
  { keywords: ["monument", "landmark", "statue"], icon: "🗽" },
  { keywords: ["lighthouse"], icon: "🚨" },
  { keywords: ["bridge"], icon: "🌉" },
  { keywords: ["farm", "ranch"], icon: "🚜" },
  { keywords: ["vineyard"], icon: "🍇" },
  { keywords: ["campground", "camping", "campsite"], icon: "🏕️" },
  { keywords: ["mountain", "hiking", "trail", "summit"], icon: "⛰️" },
  { keywords: ["beach", "coast", "shore"], icon: "🏖️" },
  { keywords: ["island"], icon: "🏝️" },
  { keywords: ["lake", "river", "waterfall"], icon: "🏞️" },
  { keywords: ["park", "garden", "botanical"], icon: "🌳" },
  { keywords: ["hotel", "motel", "resort", "inn", "lodging", "hostel"], icon: "🏨" },
  { keywords: ["apartment", "condo", "flat"], icon: "🏢" },
  { keywords: ["house", "home", "residence", "residential", "cabin", "cottage"], icon: "🏠" },
  { keywords: ["office", "coworking", "business"], icon: "🏢" },
  { keywords: ["factory", "warehouse", "industrial"], icon: "🏭" },
  { keywords: ["gas station", "fuel", "petrol"], icon: "⛽" },
  { keywords: ["airport"], icon: "✈️" },
  { keywords: ["train station", "railway station", "rail"], icon: "🚉" },
  { keywords: ["bus station", "bus stop"], icon: "🚌" },
  { keywords: ["parking", "garage"], icon: "🅿️" },
  { keywords: ["bank"], icon: "🏦" },
  { keywords: ["atm"], icon: "🏧" },
  { keywords: ["police"], icon: "🚓" },
  { keywords: ["fire station"], icon: "🚒" },
  { keywords: ["post office", "postal"], icon: "📮" },
  { keywords: ["salon", "barber", "spa", "beauty"], icon: "💇" },
  { keywords: ["market"], icon: "🏪" },
];

export function suggestIcon(category?: string, subcategory?: string): string | null {
  const text = `${subcategory ?? ""} ${category ?? ""}`.toLowerCase().trim();
  if (!text) return null;
  for (const rule of ICON_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.icon;
  }
  return null;
}
