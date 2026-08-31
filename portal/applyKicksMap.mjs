// One-off: apply the curated category map for "kicks-mania" — folds the raw
// scraped catNames into clean canonical sub-categories across all the store's
// enrolled sources. Matches raw catNames case-insensitively.
import { query } from "./db.js";
import { saveEnrollmentMappings } from "./categoryMap.js";

const MAP = {
  "Men's Shoe": ["MENS+SHOES","EID SALE","Exclusive Offer","Diwali Dhamaka Sale","Winter+Dhamaka+Sale","Men's Kick","Diwali Special Sale","PREMIUM SHOES","Biggest Sale","Diwali sale shoes","End Of Season Sale","Shoes","Diwali Offer 2022","Men's shoes","shoes+for+men","Shoe for men","Biggest sale 2025","DIWALI SALE","Shoes for Men","MENS SHOES","DIWALI+SALE+","Men’s Shoes","Bumper Sale","Diwali Sale","Mens+Shoes","Mega Sale","Mens's Sneakers","Men Shoes","Sale Product","Slides-Crocs","Sale Products","MEN’S SHOES","SPECIAL SALE","Men’s Footwear","sell+itam","DIWALI+MEN+","Sale","Onitsuka+Tiger+Models","MENS KICKS","Sale Article"],
  "Slides/Crocs": ["FLIPFLOP","Flipflops/Crocs","Flip+flops","Flip-Flop","Foam&Slide&Crocs","Crocs+","CROCS+SLIDE","slide+","crocs+%2B+slide+","Crocs","crocs+%2B+slide","Flip-flops & Slides","Birkenstock slide","Slides+","crocs","FLIP/FLOPS","Flip-flop","Flipflops","FLIP FLOP / SANDALS","Flip Flops","FlipFlop & CLOG","flip flops","Flip Flops & Crocs"],
  "Women's Shoe": ["WOMANS+SHOES","Women Sports Shoes","Women's Kick","womens","Ladies Shoes","Women's Shoes","shoes+for+women","shoes+for+girls","Shoe for girls","PREMIUM+HEELS","Shoes For Her","Womans shoes","women shoes","Womens+Shoes","women%27s+%26+men%27s+","Womens's Sneakers","WOMEN’S SHOES","Women’s Shoes","Women’s Footwear","WOMENS SHOES","DIWALI+WOMEN+SELL","Ladies+Shoes","womens Kicks"],
  "UA Quality": ["UA+QUALITY+SHOE","UA QUALITY SHOES","Men Sports Shoes","wall+Clock","UA+Quality+Shoes","Premium Shoes","UA Quality","Bottle","Premium Shoe","UA+Models","UA+QUALITY+SHOES","Ua Quality","Premium Article","Premium kicks"],
  "Formal": ["Loafers Or Formals","Formals","Party Wear Shoes"],
};

// raw(lower) -> canonical
const rawToCanon = new Map();
for (const [canon, raws] of Object.entries(MAP)) for (const r of raws) rawToCanon.set(r.toLowerCase(), canon);

const enr = (await query(`select id from enrollments where slug='kicks-mania'`)).rows[0];
if (!enr) { console.error("kicks-mania not found"); process.exit(1); }

// enrolled sources + their real cat_names
const srcs = (await query(
  `select es.source_id from enrollment_sources es join sources s on s.id=es.source_id where es.enrollment_id=$1`,
  [enr.id]
)).rows;

const mappings = [];
const matchedRaws = new Set();
for (const { source_id } of srcs) {
  const cats = (await query(`select cat_name from source_categories where source_id=$1`, [source_id])).rows;
  for (const { cat_name } of cats) {
    const canon = rawToCanon.get(String(cat_name).toLowerCase());
    if (canon) { mappings.push({ source_id, cat_name, canonical: canon }); matchedRaws.add(String(cat_name).toLowerCase()); }
  }
}

await saveEnrollmentMappings(enr.id, mappings);

const totalRaws = rawToCanon.size;
const unmatched = [...rawToCanon.keys()].filter((r) => !matchedRaws.has(r));
console.log(`sources: ${srcs.length} | category_map rows written: ${mappings.length}`);
console.log(`raw catNames in your list: ${totalRaws} | matched to real store cat_names: ${matchedRaws.size} | not present in this store: ${unmatched.length}`);
if (unmatched.length) console.log("not found (no product with this catName in kicks-mania's sources):\n  " + unmatched.join(", "));
process.exit(0);
