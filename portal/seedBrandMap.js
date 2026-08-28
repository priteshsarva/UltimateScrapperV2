// One-off: bulk-load the curated global brand map (raw -> primary [· secondary]).
// Run once:  node portal/seedBrandMap.js
import { query } from "./db.js";

// [raw, primary, secondary|null]
const MAP = [
  // Nike
  ["ADDIDAS SAMBA","Adidas","Samba"],["AIR FORCE","Nike","Air Force"],["Air Max","Nike","Air Max"],
  ["Air Zoom","Nike","Air Zoom"],["Airforce 1","Nike","Air Force 1"],["Airmax 90","Nike","Air Max 90"],
  ["Airmax 97","Nike","Air Max 97"],["Dunk Low","Nike","Dunk Low"],["Nik Air","Nike","Air"],
  ["NIK AIRFORCE","Nike","Air Force"],["Nik E","Nike",null],["Nik Ee","Nike",null],["NIK Sb","Nike","SB"],
  ["Nik_e Air","Nike","Air"],["Nik_e Airforce","Nike","Air Force"],["NIK_E Airmax","Nike","Air Max"],
  ["Nik_e SB","Nike","SB"],["Nik.E Air","Nike","Air"],["NIK.E AIRFORCE","Nike","Air Force"],
  ["NIK.E AIRMAX","Nike","Air Max"],["Nik.E Mind","Nike","Mind"],["Nik.E SB","Nike","SB"],
  ["Nike Air","Nike","Air"],["Nike Airforce","Nike","Air Force"],["Nike Airmax","Nike","Air Max"],
  ["Nike Dunk","Nike","Dunk"],["Nike SB","Nike","SB"],["Nike Zoom","Nike","Zoom"],["Nikee Air","Nike","Air"],
  ["Nikee Airforce","Nike","Air Force"],["Nikee AirMax","Nike","Air Max"],["Nikee Blazer","Nike","Blazer"],
  ["Nikee Dunk","Nike","Dunk"],["Nikee Jordan","Nike","Jordan"],["Nikee Mind","Nike","Mind"],
  ["Nikee SB","Nike","SB"],["Nikee Shox","Nike","Shox"],["Nikee Zoom","Nike","Zoom"],["Nikke Air","Nike","Air"],
  ["Sb Dunk","Nike","SB Dunk"],["Travis Scott","Nike","Travis Scott"],
  // Jordan
  ["Air Jordan","Jordan","Air Jordan"],["Jorda N","Jordan",null],["Jordan 1","Jordan","1"],
  ["Jordan 4","Jordan","4"],["Jordan Retro","Jordan","Retro"],["Retro 1","Jordan","Retro 1"],
  // Adidas
  ["ADDIDAS YEEZY","Adidas","Yeezy"],["Adida S","Adidas",null],["Adida_s Samba","Adidas","Samba"],
  ["ADIDA_S YEEZY","Adidas","Yeezy"],["Adida.S Samba","Adidas","Samba"],["Adidas Samba","Adidas","Samba"],
  ["Adidas Yeezy","Adidas","Yeezy"],["Adidass Adizero","Adidas","Adizero"],["Adidass Bad","Adidas","Bad Bunny"],
  ["Adidass Campus","Adidas","Campus"],["Adidass Samba","Adidas","Samba"],["Adidass UltraBoost","Adidas","UltraBoost"],
  ["Adidass X","Adidas","X"],["Adidass Yeezy","Adidas","Yeezy"],["Bad Bunny","Adidas","Bad Bunny"],
  ["Yeezy 350","Adidas","Yeezy 350"],["Yeezy Boost","Adidas","Yeezy Boost"],
  // Rolex
  ["Role X","Rolex",null],["Role_x Automatic","Rolex","Automatic"],["Role_x Celine","Rolex","Cellini"],
  ["Role_x Day","Rolex","Day-Date"],["Role_x Daytona","Rolex","Daytona"],["Role_x GMT","Rolex","GMT-Master"],
  ["ROLE_X JUST","Rolex","Datejust"],["Role_x Land","Rolex","Air-King"],["Role_x Oyester","Rolex","Oyster Perpetual"],
  ["Role_x Oyster","Rolex","Oyster Perpetual"],["Role_x Sky","Rolex","Sky-Dweller"],["Role_x Watch","Rolex",null],
  ["Rolee X","Rolex",null],["Rolee_x Oyster","Rolex","Oyster Perpetual"],["ROLEX AUTOMATIC","Rolex","Automatic"],
  ["Rolex Date","Rolex","Date"],["ROLEX DAY","Rolex","Day-Date"],["ROLEX DAYTONA","Rolex","Daytona"],
  ["ROLEX GMT","Rolex","GMT-Master"],["ROLEX LAND","Rolex","Air-King"],["Rolex Oyster","Rolex","Oyster Perpetual"],
  ["ROLEX SKY","Rolex","Sky-Dweller"],["Rolex Submariner","Rolex","Submariner"],
  // Casio
  ["Casi O","Casio",null],["Casio AE-1200","Casio","AE-1200"],["Casio Edifice","Casio","Edifice"],
  ["Casio G","Casio","G-Shock"],["Casio G-Shock","Casio","G-Shock"],["Casio Gshock","Casio","G-Shock"],
  ["Casio Illuminator","Casio","Illuminator"],["Casio Vintage","Casio","Vintage"],["Edifice Casio","Casio","Edifice"],
  ["G Shock","Casio","G-Shock"],
  // Fossil
  ["Fossi L","Fossil",null],["Fossi_l Automatic","Fossil","Automatic"],["Fossi_l Bannon","Fossil","Bannon"],
  ["Fossi_l Bronson","Fossil","Bronson"],["Fossi_l Commuter","Fossil","Commuter"],["Fossi_l Grant","Fossil","Grant"],
  ["Fossi_l Jacqueline","Fossil","Jacqueline"],["Fossi_l Neutra","Fossil","Neutra"],["Fossi_l Neutro","Fossil","Neutra"],
  ["Fossi_l Townsman","Fossil","Townsman"],["Fossi_l Watch","Fossil",null],["Fossil Automatic","Fossil","Automatic"],
  // Onitsuka Tiger
  ["Onitsuk A","Onitsuka Tiger",null],["Onitsuk_a Tiger","Onitsuka Tiger",null],["Onitsuk.A Tiger","Onitsuka Tiger",null],
  ["Onitsuka Tiger","Onitsuka Tiger",null],["Onitsukaa Tiger","Onitsuka Tiger",null],["Onitsukka Tiger","Onitsuka Tiger",null],
  ["Tiger Mexico","Onitsuka Tiger","Mexico 66"],
  // Patek Philippe
  ["Pate K","Patek Philippe",null],["Pate_k Philippe","Patek Philippe",null],["Patee_k Philippe","Patek Philippe",null],
  ["Patek Philipp","Patek Philippe",null],["Patek Philipp_e","Patek Philippe",null],["PATEK PHILIPPE","Patek Philippe",null],
  ["Patek Phillip","Patek Philippe",null],["Patek Phillipe","Patek Philippe",null],
  ["Patek_philippe Automatic","Patek Philippe","Automatic"],["Patek_philippe Nautilus","Patek Philippe","Nautilus"],
  ["Patek_philippe Skeleton","Patek Philippe","Skeleton"],
  // Tissot
  ["Tisso T","Tissot",null],["Tisso_t 1853","Tissot","1853"],["Tisso_t PRX","Tissot","PRX"],["Tisso_t Watch","Tissot",null],
  ["Tissoo_t 1853","Tissot","1853"],["TISSOT 1853","Tissot","1853"],["TISSOT PRX","Tissot","PRX"],
  // New Balance
  ["New Balanc","New Balance",null],["New Balanc_e","New Balance",null],["New Balanc_ee","New Balance",null],
  ["New Balanc.E","New Balance",null],["New Balance","New Balance",null],["New Balancee","New Balance",null],
  ["NEWW BALANCE","New Balance",null],["Neww Balancee","New Balance",null],
  // Armani
  ["ARMA EXCHANGE","Armani Exchange",null],["Arman Exchange","Armani Exchange",null],["Arman I","Armani",null],
  ["Arman_i Exchange","Armani Exchange",null],["Arman_I Watch","Armani",null],["ARMANI EXCHANGE","Armani Exchange",null],
  ["Empori O","Emporio Armani",null],["EMPORIO ARMA","Emporio Armani",null],["Emporio Arman","Emporio Armani",null],
  ["Emporio Arman_i","Emporio Armani",null],["Emporio Armani","Emporio Armani",null],
  // Michael Kors
  ["Michae L","Michael Kors",null],["Michae_l Kors","Michael Kors",null],["Michael Kor","Michael Kors",null],
  ["Michael Kor_s","Michael Kors",null],["Michael Kors","Michael Kors",null],["Michael_Kors Darci","Michael Kors","Darci"],
  ["Michael_Kors Ladies","Michael Kors","Ladies"],["Michael_kors Parker","Michael Kors","Parker"],
  ["MICHAEL_KORS WATCH","Michael Kors",null],["Michael_l Kors","Michael Kors",null],["Micheal Kors","Michael Kors",null],
  // Rado
  ["Rad O","Rado",null],["Rad_o Captain","Rado","Captain Cook"],["Rad_o Centrix","Rado","Centrix"],
  ["Rad_o Diastar","Rado","DiaStar"],["Rad_o Jubli","Rado","Jubile"],["Rad_o True","Rado","True"],
  ["Rad_o Watch","Rado",null],["RADO AUTOMATIC","Rado","Automatic"],["Rado Captain","Rado","Captain Cook"],
  ["Rado Centrix","Rado","Centrix"],["Rado True","Rado","True"],
  // Hublot
  ["Hublo T","Hublot",null],["Hublo_t Big","Hublot","Big Bang"],["Hublo_t Bigbang","Hublot","Big Bang"],
  ["HUBLOT","Hublot",null],["Hublot Automatic","Hublot","Automatic"],["Hublot Big","Hublot","Big Bang"],
  ["Hublot Bigbang","Hublot","Big Bang"],["Hublot Classic","Hublot","Classic Fusion"],
  // Omega
  ["Omeg A","Omega",null],["Omeg_a Constellation","Omega","Constellation"],["Omeg_a Seamaster","Omega","Seamaster"],
  ["Omeg_a Speedmaster","Omega","Speedmaster"],["OMEGA CONSTELLATION","Omega","Constellation"],
  ["OMEGA SEAMASTER","Omega","Seamaster"],["Omega Speedmaster","Omega","Speedmaster"],
  // Tommy Hilfiger
  ["Tomm Y","Tommy Hilfiger",null],["Tomm_y Hilfiger","Tommy Hilfiger",null],["Tommy Hilfige","Tommy Hilfiger",null],
  ["Tommy Hilfige_r","Tommy Hilfiger",null],["TOMMY HILFIGER","Tommy Hilfiger",null],["TOMMY HILIFIGER","Tommy Hilfiger",null],
  ["Tommy_Hilfiger Automatic","Tommy Hilfiger","Automatic"],["Tommy_Hilfiger Decker","Tommy Hilfiger","Decker"],
  // On Running
  ["On Cloud","On Running","Cloud"],["On Cloudboom","On Running","Cloudboom"],["On Cloudmonster","On Running","Cloudmonster"],
  ["On Cloudsurfer","On Running","Cloudsurfer"],["ON CLOUDTILT","On Running","Cloudtilt"],["On Running","On Running",null],
  // Cartier
  ["Cartie R","Cartier",null],["Cartie_r Baloon","Cartier","Ballon Bleu"],["Cartie_r Santos","Cartier","Santos"],
  ["Cartier Santos","Cartier","Santos"],
  // Audemars Piguet
  ["Audemar S","Audemars Piguet",null],["Audemars Pigue","Audemars Piguet",null],["Audemars Pigue_t","Audemars Piguet",null],
  ["Audemars Piguet","Audemars Piguet",null],["Audemars_piguet Royal","Audemars Piguet","Royal Oak"],
  // Tag Heuer
  ["Tag Heue","Tag Heuer",null],["Tag Heue_r","Tag Heuer",null],["Tag Heuee_r","Tag Heuer",null],
  ["Tag Heuer","Tag Heuer",null],["Tag_heuer Carrera","Tag Heuer","Carrera"],
  // Louis Vuitton
  ["Loui Vuitton","Louis Vuitton",null],["Loui_s Vuitton","Louis Vuitton",null],["LOUI.S VUITTON","Louis Vuitton",null],
  ["Louiis Vuitton","Louis Vuitton",null],["Louis Vuitton","Louis Vuitton",null],["Louiss Vuitton","Louis Vuitton",null],
  // Seiko
  ["Seik O","Seiko",null],["Seiko 5","Seiko","5"],["Seiko Automatic","Seiko","Automatic"],["Seiko Gmt","Seiko","GMT"],
  ["Seiko Nautilus","Seiko","Nautilus"],["Seiko Presage","Seiko","Presage"],["Seiko Prospex","Seiko","Prospex"],
  // Bvlgari
  ["Bvlgar I","Bvlgari",null],["Bvlgari Octo","Bvlgari","Octo"],["Bvlgari Serpenti","Bvlgari","Serpenti"],
  // Asics
  ["Asic S","Asics",null],["Asic.S Gel","Asics","GEL"],["Asicss GEL","Asics","GEL"],
  // Birkenstock
  ["Birkenstock Arizona","Birkenstock","Arizona"],["Birkenstock Boston","Birkenstock","Boston"],
  // Calvin Klein
  ["Calvi_n Klein","Calvin Klein",null],["Calvin Klei","Calvin Klein",null],["Calvin Klein","Calvin Klein",null],
  // Crocs
  ["CROC S","Crocs",null],["Crocss 360","Crocs","360"],["Crocss Bayaband","Crocs","Bayaband"],
  // Diesel
  ["Diese_l 10","Diesel","10"],["Diese_l 3","Diesel","3"],
  // Gucci
  ["Gucc I","Gucci",null],
  // Jacob & Co.
  ["Jacob &","Jacob & Co.",null],["Jacob Co","Jacob & Co.",null],
  // Loro Piana
  ["Loro Piana","Loro Piana",null],["Loro Piano","Loro Piana",null],
  // Puma
  ["Pum A","Puma",null],["Pum Aa","Puma",null],["Pumaa Fast","Puma","Fast"],["Pumaa Speedcat","Puma","Speedcat"],
  // Skechers
  ["Skecher.S Go","Skechers","Go Walk"],["Skecher.S Hyper","Skechers","Hyper Burst"],
  ["Skechers Hyper","Skechers","Hyper Burst"],["Skecherss Hyper","Skechers","Hyper Burst"],
  // Under Armour
  ["Under Armour","Under Armour",null],["Underr Armour","Under Armour",null],
  // Versace
  ["Versac E","Versace",null],["Versace Greca","Versace","Greca"],["Versace Heritage","Versace","Heritage"],
  // Balenciaga
  ["Balenciaga Speed","Balenciaga","Speed"],["Balenciaga Triple","Balenciaga","Triple S"],
  // Ralph Lauren
  ["Ralp Lauren","Ralph Lauren",null],["RL POLO","Ralph Lauren","Polo"],
  // Singles / direct
  ["Alexander McQueen","Alexander McQueen",null],["Citizen Tsuyosa","Citizen","Tsuyosa"],
  ["Daniel Wellington","Daniel Wellington",null],["Dio R","Dior",null],["DOLCE GABBANA","Dolce & Gabbana",null],
  ["Fear Of","Fear of God",null],["Ferrari Scuderia","Ferrari","Scuderia"],["Franck Muller","Franck Muller",null],
  ["Golden Goose","Golden Goose",null],["Gues S","Guess",null],["Hoka One","Hoka","One One"],
  ["Just Cavalli","Roberto Cavalli","Just Cavalli"],["Loewe X","Loewe",null],["Luminor Panerai","Panerai","Luminor"],
  ["Marc Jacobs","Marc Jacobs",null],["Maserati Automatic","Maserati","Automatic"],["Maurice Lacroix","Maurice Lacroix",null],
  ["Mont Blanc","Montblanc",null],["Prad A","Prada",null],["Reebok Zig","Reebok","Zig"],
  ["Richard Mill","Richard Mille",null],["Richard Mille","Richard Mille",null],["Roger Dubuis","Roger Dubuis",null],
  ["Swarovsk I","Swarovski",null],["Tudor Black","Tudor","Black Bay"],["Ulysse Nardin","Ulysse Nardin",null],
  ["Vacheron Constantin","Vacheron Constantin",null],["Vans Old","Vans","Old Skool"],
];

const rows = MAP.map(([raw, primary, secondary]) => `(${[raw.toLowerCase(), primary, secondary]
  .map((v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`)).join(",")})`);

const sql = `insert into brand_map (raw, canonical, secondary) values ${rows.join(",")}
  on conflict (raw) do update set canonical = excluded.canonical, secondary = excluded.secondary, updated_at = now()`;

const r = await query(sql);
console.log(`seeded ${MAP.length} brand mappings (rowCount ${r.rowCount})`);
process.exit(0);
