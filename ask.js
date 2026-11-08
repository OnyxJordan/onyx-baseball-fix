// ask.js - "Ask Onyx": type what you want, get plays or a parlay built from today's boards.
//
// The plays always come from our models and Onyx's live prices (data/<sport>/board.json,
// written by every build through daily_top.write_board). Language is only turned into a
// FILTER SPEC, never into picks:
//   1. if ai.json names a relay URL (ai/worker.js, deployed by .github/workflows/ai_worker.yml),
//      the sentence goes there and comes back as a spec
//   2. otherwise (or if the relay fails) a built-in parser reads the common requests
// The spec is the one contract between the two (ai/worker.js holds the same schema):
//   {intent: "parlay"|"sgp"|"list", count, sports[], markets[], side: "over"|"under"|"any",
//    min_price, max_price, min_conf, min_edge, player, team, sort: "conf"|"rec"|"edge"|"price"|"two_td",
//    one_per_game, exclude[], summary}
// With the relay on, the AI also gets the previous answer (ctx) so follow-ups work ("swap leg 2",
// "make it +500", "same but NBA"), says one line back (say), and explains the legs afterwards
// (explain) from their numbers only. Without it, the built-in parser handles "swap leg N".
(function () {
  var SPORTS = ['nba', 'nfl', 'cfb', 'cbb', 'nhl', 'tennis'];
  var LG = {nba: 'NBA', nfl: 'NFL', cfb: 'NCAAF', cbb: 'NCAAB', nhl: 'NHL', tennis: 'Tennis'};
  var PAGE = {nba: 'nba.html', nfl: 'nfl.html', cfb: 'cfb.html', cbb: 'cbb.html', nhl: 'nhl.html', tennis: 'tennis.html'};
  // where each sport's depth chart lives (data/<sport>/depth.json)
  var DEPTHPG = {nba: 'nba.html#depth', cbb: 'cbb-players.html#', cfb: 'cfb.html#depth:', nfl: 'nfl.html#depth:', nhl: 'nhl.html#depth:'};
  var PICKS = {today: [], final: []};   // Onyx Picks still to play today (data/picks/ledger.json) and the finalized markets
  var MKTS = ['pts', 'reb', 'ast', 'q1_total', 'h1_total', 'first_basket', 'first_td', 'rec', 'rec_yds', 'rush_yds', 'pass_yds', 'pass_td', 'pass_att', 'rush_rec_yds', 'pass_rush_yds', 'anytime_td', 'two_plus_td', 'three_td', 'spread', 'total', 'ml'];
  var BOARD = null, AI = null, PRIOR = [];
  // every rostered player (data/<sport>/names.json from the depth charts, 11/6): known even with no
  // line today, matched on the full name only, after today's boards and the NBA record
  var ROSTER = {};

  function getJSON(u) { return fetch(u, {cache: 'no-cache'}).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }
  function loadBoards() {
    if (BOARD) return Promise.resolve(BOARD);
    var prior = getJSON('data/nba/prior.json').then(function (P) {
      PRIOR = Object.keys(P || {}).map(function (k) { var r = P[k]; return {n: r.n, ppg: r.gp ? r.pts / r.gp : 0}; });
    }).catch(function () {});
    // Onyx Picks (11/2): only finalized markets are picks; every other play is a projection
    var picks = Promise.all([getJSON('data/picks/ledger.json').catch(function () { return []; }), getJSON('data/picks/backtest.json').catch(function () { return {}; })]);
    var roster = Promise.all(['nfl', 'cfb', 'nhl', 'cbb'].map(function (k) {
      return getJSON('data/' + k + '/names.json').then(function (L) {
        (L || []).forEach(function (r) { var c = clean(r[0]); if (c && c.split(' ').length >= 2 && !ROSTER[c]) ROSTER[c] = {name: r[0], sp: k, team: r[1]}; });
      }).catch(function () {});
    }));
    return Promise.all(SPORTS.map(function (k) { return getJSON('data/' + k + '/board.json').catch(function () { return null; }); }).concat([prior, picks, roster]))
      .then(function (fs) {
        BOARD = []; fs.slice(0, SPORTS.length).forEach(function (f) { (f && f.plays || []).forEach(function (p) { BOARD.push(p); }); });
        var pk = fs[SPORTS.length + 1] || [[], {}], L = Array.isArray(pk[0]) ? pk[0] : (pk[0] && (pk[0].picks || pk[0].rows)) || [];
        PICKS.final = (pk[1] && pk[1].finalized) || [];
        var sel = {}; L.forEach(function (r) { if (r && r.sel && !r.result) sel[r.sel] = r; });
        PICKS.today = L.filter(function (r) { return r && !r.result && Date.parse(r.start) > Date.now(); });
        BOARD.forEach(function (p) { if (p.sel && sel[p.sel]) p.pick = true; });
        return BOARD;
      });
  }
  function aiUrl() {
    if (AI !== null) return Promise.resolve(AI);
    return getJSON('ai.json').then(function (j) { AI = (j && j.url) || ''; return AI; }).catch(function () { AI = ''; return AI; });
  }

  // ── the built-in parser: no AI, no keys. Reads the request against today's
  // boards, so it knows every player and team that has a line today. ─────────
  var WORDS = [
    [/\b(1st|first)\s*(td|touchdown|scorer of the game|to score)\b|\bftd\b|\bfirst (td|touchdown) scorer\b/, 'first_td'],
    [/\b(1st|first)\s*(basket|bucket|field goal|points? of the game|to score in)\b|\bfirst baskets?\b/, 'first_basket'],
    [/\b(1st|first)[\s-]*half\b|\b1h\b|\bh1\b|\bhalftime\b/, 'h1_total'],
    [/\bpass(ing)? attempts?\b|\bpass att\b|\bthrows\b|\battempts\b/, 'pass_att'],
    [/\b(rush(ing)?|run(ning)?) (\+|and|&|plus) rec(eiving)? (yards|yds)\b|\bscrimmage yards\b|\brush ?\+ ?rec\b/, 'rush_rec_yds'],
    [/\bpass(ing)? (\+|and|&|plus) rush(ing)? (yards|yds)\b|\bpass ?\+ ?rush\b|\btotal qb yards\b/, 'pass_rush_yds'],
    [/\bpass(ing)?\s*(td|tds|touchdowns?)\b|\b(td|touchdown) pass(es)?\b|\b(qb|quarterback)s?('s)? (td|tds|touchdowns?)\b/, 'pass_td'],
    [/\b(3|three)\s*\+\s*(td|tds|touchdowns?)\b|\b(3|three) or more (td|tds|touchdowns?)\b/, 'three_td'],   // 3+ touchdowns: Onyx's over 2.5 (11/8)
    [/\b(2|two)\+?\s*(td|tds|touchdowns?)\b|\b(2|two) or more (td|tds|touchdowns?)\b|\bmultiple (td|tds|touchdowns)\b|\bmulti[\s-]?td\b|\bdouble (td|tds|touchdown)/, 'two_plus_td'],
    [/\b(anytime\s*)?(td|tds|touchdowns?)\b|\b(td|touchdown) scorers?\b|\bfind the end ?zone\b|\bscore a td\b|\b(picks?|players?|guys?|scorers?|favorites?|favs?)( \w+)? to score\b(?!\s*(\d|a goal|goals?|points|pts|runs?|a run|a basket))|\bto score (today|tonight|sunday|this week)\b/, 'anytime_td'],
    [/\b(1st|first)[\s-]*(quarter|q)\b|\b1q\b|\bq1\b/, 'q1_total'],
    [/\brebound(s|ing|er|ers)?\b|\breb\b|\bboards\b|\brebs\b/, 'reb'],
    [/\bassists?\b|\bast\b|\bdimes\b|\bdishes\b/, 'ast'],
    [/\breceptions?\b|\bcatches\b|\brecs\b/, 'rec'],
    [/\breceiving\b|\brec(eiving)? yds\b|\breceivers?\b|\bwideouts?\b|\bwrs?\b|\btight ends?\b/, 'rec_yds'],
    [/\brushing\b|\brush\b|\brushers?\b|\bcarries\b|\bground game\b|\brunning backs?\b|\brbs?\b/, 'rush_yds'],
    [/\bpassing\b|\bpass yards\b|\bpassers?\b|\bqbs?\b|\bquarterbacks?\b|\bthrowing\b/, 'pass_yds'],
    [/(?<!\bhigh )\bpoints?\b(?!\s*(guards?|spr[a-z]*))|\bpts\b|\bscorers?\b|\bscoring\b|\bbuckets\b/, 'pts'],
    [/\bspreads?\b|\bpoint spr[a-z]*\b|\bspreds?\b|\bsprads?\b|\bcover(s|ing)?\b|\bpuck ?lines?\b|\bhandicap\b|\bats\b/, 'spread'],
    [/\b(game )?totals?\b(?!\s*(parlay\s+)?(odds|payout|price|of\s+\+))|\bo\/u\b|\bover ?\/? ?unders?\b|\bover[\s-]unders?\b/, 'total'],
    [/\bmoney ?lines?\b|\bml\b|\bto win\b(?!\s*(about|around)?\s*\+?\$?\d)|\bwinners?\b|\bstraight up\b|\boutright\b/, 'ml'],
  ];
  // college basketball and college football in every wording (11/2)
  var CBBW = /\b(college|ncaa|ncaam|ncaa mens|mens college|men s college|d1|division (1|i)|collegiate) ?(mens |men s )?(basketball|hoops|bball|b-ball|hoop)\b|\bncaa ?b\b|\bncaab\b|\bncaam\b|\bncaambb\b|\bcbb\b|\bcbk\b|\bmarch madness\b|\bncaa tournament\b|\bbig dance\b|\bfinal four\b|\bsweet (16|sixteen)\b|\belite (8|eight)\b/;
  var CFBW = /\b(college|ncaa|d1|division (1|i)|collegiate) ?football\b|\bncaa ?f\b|\bncaaf\b|\bcfb\b|\bfbs\b|\bfcs\b|\bcollege fb\b|\bcfp\b|\bcollege football playoff\b/;
  var NICK = {
    // NBA
    hawks: 'ATL', celtics: 'BOS', nets: 'BKN', hornets: 'CHA', bulls: 'CHI', cavs: 'CLE', cavaliers: 'CLE', mavs: 'DAL', mavericks: 'DAL',
    nuggets: 'DEN', pistons: 'DET', warriors: 'GS', dubs: 'GS', rockets: 'HOU', pacers: 'IND', clippers: 'LAC', lakers: 'LAL', grizzlies: 'MEM',
    heat: 'MIA', bucks: 'MIL', wolves: 'MIN', timberwolves: 'MIN', pelicans: 'NO', knicks: 'NY', thunder: 'OKC', magic: 'ORL', sixers: 'PHI',
    '76ers': 'PHI', suns: 'PHX', blazers: 'POR', 'trail blazers': 'POR', kings: 'SAC', spurs: 'SA', raptors: 'TOR', jazz: 'UTAH', wizards: 'WSH',
    // NFL
    cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI', bengals: 'CIN', browns: 'CLE', cowboys: 'DAL',
    broncos: 'DEN', lions: 'DET', packers: 'GB', texans: 'HOU', colts: 'IND', jaguars: 'JAX', jags: 'JAX', chiefs: 'KC', raiders: 'LV',
    chargers: 'LAC', rams: 'LAR', dolphins: 'MIA', vikings: 'MIN', patriots: 'NE', pats: 'NE', saints: 'NO', giants: 'NYG', jets: 'NYJ',
    eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', niners: 'SF', seahawks: 'SEA', bucs: 'TB', buccaneers: 'TB', titans: 'TEN', commanders: 'WSH',
    // NHL
    bruins: 'BOS', sabres: 'BUF', flames: 'CGY', hurricanes: 'CAR', blackhawks: 'CHI', avalanche: 'COL', avs: 'COL', 'blue jackets': 'CBJ', stars: 'DAL',
    'red wings': 'DET', oilers: 'EDM', canes: 'CAR', ducks: 'ANA', 'golden knights': 'VGK', knights: 'VGK', canadiens: 'MTL', habs: 'MTL', predators: 'NSH',
    preds: 'NSH', devils: 'NJ', islanders: 'NYI', rangers: 'NYR', senators: 'OTT', flyers: 'PHI', penguins: 'PIT', pens: 'PIT', sharks: 'SJ', kraken: 'SEA',
    blues: 'STL', lightning: 'TB', bolts: 'TB', 'maple leafs': 'TOR', leafs: 'TOR', canucks: 'VAN', capitals: 'WSH', caps: 'WSH', winnipeg: 'WPG', 'utah hockey': 'UTA', mammoth: 'UTA', 'utah mammoth': 'UTA'
  };
  var SPORT_OF_NICK = {jets: 'nfl', kings: 'nba', panthers: 'nfl', rangers: 'nhl', cardinals: 'nfl', giants: 'nfl'};
  // every nickname's league, from the order NICK lists them in (NBA, then NFL, then NHL)
  (function () {
    var cur = 'nba';
    Object.keys(NICK).forEach(function (k) {
      if (k === 'cardinals') cur = 'nfl'; else if (k === 'bruins') cur = 'nhl';
      if (!SPORT_OF_NICK[k]) SPORT_OF_NICK[k] = cur;
    });
  })();
  // ── college and pro teams by name (11/2) ─────────────────────────────────
  // Every Division I school, so a college name never pulls a pro team and a pro city never pulls
  // a college. cbb abbr | cfb abbr (FBS only) | school | mascot: ESPN's abbreviations, the ones the
  // boards use (from data/cbb/depth.json, data/cbb/teams_espn.json and data/cfb/depth.json).
  var D1 = 'ACU||Abilene Christian|Wildcats;AF|AFA|Air Force|Falcons;AKR|AKR|Akron|Zips;AAMU||Alabama A&M|Bulldogs;ALA|ALA|Alabama|Crimson Tide;ALST||Alabama State|Hornets;ALCN||Alcorn State|Braves;AMER||American University|Eagles;APP|APP|App State|Mountaineers;ASU|ASU|Arizona State|Sun Devils;ARIZ|ARIZ|Arizona|Wildcats;ARK|ARK|Arkansas|Razorbacks;ARST|ARST|Arkansas State|Red Wolves;UAPB||Arkansas-Pine Bluff|Golden Lions;ARMY|ARMY|Army|Black Knights;AUB|AUB|Auburn|Tigers;APSU||Austin Peay|Governors;BYU|BYU|BYU|Cougars;BALL|BALL|Ball State|Cardinals;BAY|BAY|Baylor|Bears;BELL||Bellarmine|Knights;BEL||Belmont|Bruins;BCU||Bethune-Cookman|Wildcats;BING||Binghamton|Bearcats;BOIS|BOIS|Boise State|Broncos;BC|BC|Boston College|Eagles;BU||Boston University|Terriers;BGSU|BGSU|Bowling Green|Falcons;BRAD||Bradley|Braves;BRWN||Brown|Bears;BRY||Bryant|Bulldogs;BUCK||Bucknell|Bison;BUF|BUFF|Buffalo|Bulls;BTLR||Butler|Bulldogs;CP||Cal Poly|Mustangs;CSUB||Cal State Bakersfield|Roadrunners;CSUF||Cal State Fullerton|Titans;CSUN||Cal State Northridge|Matadors;CBU||California Baptist|Lancers;CAL|CAL|California|Golden Bears;CAM||Campbell|Fighting Camels;CAN||Canisius|Golden Griffins;CARK||Central Arkansas|Bears;CCSU||Central Connecticut|Blue Devils;CMU|CMU|Central Michigan|Chippewas;COFC||Charleston|Cougars;CHSO||Charleston Southern|Buccaneers;CLT|CLT|Charlotte|49ers;UTC||Chattanooga|Mocs;CHST||Chicago State|Cougars;CIN|CIN|Cincinnati|Bearcats;CLEM|CLEM|Clemson|Tigers;CLE||Cleveland State|Vikings;CCU|CCU|Coastal Carolina|Chanticleers;COLG||Colgate|Raiders;COLO|COLO|Colorado|Buffaloes;CSU|CSU|Colorado State|Rams;COLU||Columbia|Lions;COPP||Coppin State|Eagles;COR||Cornell|Big Red;CREI||Creighton|Bluejays;DART||Dartmouth|Big Green;DAV||Davidson|Wildcats;DAY||Dayton|Flyers;DEP||DePaul|Blue Demons;DEL|DEL|Delaware|Blue Hens;DSU||Delaware State|Hornets;DEN||Denver|Pioneers;DETM||Detroit Mercy|Titans;DRKE||Drake|Bulldogs;DREX||Drexel|Dragons;DUKE|DUKE|Duke|Blue Devils;DUQ||Duquesne|Dukes;ECU|ECU|East Carolina|Pirates;ETSU||East Tennessee State|Buccaneers;ETAM||East Texas A&M|Lions;EIU||Eastern Illinois|Panthers;EKU||Eastern Kentucky|Colonels;EMU|EMU|Eastern Michigan|Eagles;EWU||Eastern Washington|Eagles;ELON||Elon|Phoenix;EVAN||Evansville|Purple Aces;FAIR||Fairfield|Stags;FDU||Fairleigh Dickinson|Knights;FAMU||Florida A&M|Rattlers;FAU|FAU|Florida Atlantic|Owls;FLA|FLA|Florida|Gators;FGCU||Florida Gulf Coast|Eagles;FIU|FIU|Florida International|Panthers;FSU|FSU|Florida State|Seminoles;FOR||Fordham|Rams;FRES|FRES|Fresno State|Bulldogs;FUR||Furman|Paladins;GWEB||Gardner-Webb|Runnin\' Bulldogs;GMU||George Mason|Patriots;GW||George Washington|Revolutionaries;GTWN||Georgetown|Hoyas;UGA|UGA|Georgia|Bulldogs;GASO|GASO|Georgia Southern|Eagles;GAST|GAST|Georgia State|Panthers;GT|GT|Georgia Tech|Yellow Jackets;GONZ||Gonzaga|Bulldogs;GRAM||Grambling|Tigers;GCU||Grand Canyon|Lopes;GB||Green Bay|Phoenix;HAMP||Hampton|Pirates;HARV||Harvard|Crimson;HAW|HAW|Hawai\'i|Rainbow Warriors;HPU||High Point|Panthers;HOF||Hofstra|Pride;HC||Holy Cross|Crusaders;HCU||Houston Christian|Huskies;HOU|HOU|Houston|Cougars;HOW||Howard|Bison;IUIN||IU Indianapolis|Jaguars;IDST||Idaho State|Bengals;IDHO||Idaho|Vandals;ILL|ILL|Illinois|Fighting Illini;ILST||Illinois State|Redbirds;UIW||Incarnate Word|Cardinals;IU|IU|Indiana|Hoosiers;INST||Indiana State|Sycamores;IONA||Iona|Gaels;IOWA|IOWA|Iowa|Hawkeyes;ISU|ISU|Iowa State|Cyclones;JKST||Jackson State|Tigers;JAX||Jacksonville|Dolphins;JXST|JXST|Jacksonville State|Gamecocks;JMU|JMU|James Madison|Dukes;KC||Kansas City|Roos;KU|KU|Kansas|Jayhawks;KSU|KSU|Kansas State|Wildcats;KENN|KENN|Kennesaw State|Owls;KENT|KENT|Kent State|Golden Flashes;UK|UK|Kentucky|Wildcats;NOLA||LSU New Orleans|Privateers;LSU|LSU|LSU|Tigers;LAS||La Salle|Explorers;LAF||Lafayette|Leopards;LAM||Lamar|Cardinals;LEM||Le Moyne|Dolphins;LEH||Lehigh|Mountain Hawks;LIB|LIB|Liberty|Flames;LIP||Lipscomb|Bisons;LR||Little Rock|Trojans;LBSU||Long Beach State|Beach;LIU||Long Island University|Sharks;LONG||Longwood|Lancers;UL|UL|Louisiana|Ragin\' Cajuns;LT|LT|Louisiana Tech|Bulldogs;LOU|LOU|Louisville|Cardinals;LUC||Loyola Chicago|Ramblers;L-MD||Loyola Maryland|Greyhounds;LMU||Loyola Marymount|Lions;ME||Maine|Black Bears;MAN||Manhattan|Jaspers;MRST||Marist|Red Foxes;MARQ||Marquette|Golden Eagles;MRSH|MRSH|Marshall|Thundering Herd;UMES||Maryland Eastern Shore|Hawks;MD|MD|Maryland|Terrapins;MASS|MASS|Massachusetts|Minutemen;MCN||McNeese|Cowboys;MEM|MEM|Memphis|Tigers;MER||Mercer|Bears;MERC||Mercyhurst|Lakers;MRMK||Merrimack|Warriors;M-OH|M-OH|Miami (OH)|RedHawks;MIA|MIA|Miami|Hurricanes;MSU|MSU|Michigan State|Spartans;MICH|MICH|Michigan|Wolverines;MTSU|MTSU|Middle Tennessee|Blue Raiders;MILW||Milwaukee|Panthers;MINN|MINN|Minnesota|Golden Gophers;MSST|MSST|Mississippi State|Bulldogs;MVSU||Mississippi Valley State|Delta Devils;MOST|MOST|Missouri State|Bears;MIZ|MIZ|Missouri|Tigers;MONM||Monmouth|Hawks;MONT||Montana|Grizzlies;MTST||Montana State|Bobcats;MORE||Morehead State|Eagles;MORG||Morgan State|Bears;MSM||Mount St. Mary\'s|Mountaineers;MUR||Murray State|Racers;NCSU|NCSU|NC State|Wolfpack;NJIT||NJIT|Highlanders;NAVY|NAVY|Navy|Midshipmen;NEB|NEB|Nebraska|Cornhuskers;NEV|NEV|Nevada|Wolf Pack;UNH||New Hampshire|Wildcats;NHVN||New Haven|Chargers;UNM|UNM|New Mexico|Lobos;NMSU|NMSU|New Mexico State|Aggies;NIA||Niagara|Purple Eagles;NICH||Nicholls|Colonels;NORF||Norfolk State|Spartans;UNA||North Alabama|Lions;NCAT||North Carolina A&T|Aggies;NCCU||North Carolina Central|Eagles;UNC|UNC|North Carolina|Tar Heels;UND||North Dakota|Fighting Hawks;NDSU|NDSU|North Dakota State|Bison;UNF||North Florida|Ospreys;UNT|UNT|North Texas|Mean Green;NE||Northeastern|Huskies;NAU||Northern Arizona|Lumberjacks;UNCO||Northern Colorado|Bears;NIU|NIU|Northern Illinois|Huskies;UNI||Northern Iowa|Panthers;NKU||Northern Kentucky|Norse;NWST||Northwestern State|Demons;NU|NU|Northwestern|Wildcats;ND|ND|Notre Dame|Fighting Irish;OAK||Oakland|Golden Grizzlies;OHIO|OHIO|Ohio|Bobcats;OSU|OSU|Ohio State|Buckeyes;OU|OU|Oklahoma|Sooners;OKST|OKST|Oklahoma State|Cowboys;ODU|ODU|Old Dominion|Monarchs;MISS|MISS|Ole Miss|Rebels;OMA||Omaha|Mavericks;ORU||Oral Roberts|Golden Eagles;ORE|ORE|Oregon|Ducks;ORST|ORST|Oregon State|Beavers;PAC||Pacific|Tigers;PSU|PSU|Penn State|Nittany Lions;PENN||Pennsylvania|Quakers;PEPP||Pepperdine|Waves;PITT|PITT|Pittsburgh|Panthers;PORT||Portland|Pilots;PRST||Portland State|Vikings;PV||Prairie View A&M|Panthers;PRES||Presbyterian|Blue Hose;PRIN||Princeton|Tigers;PROV||Providence|Friars;PUR|PUR|Purdue|Boilermakers;PFW||Purdue Fort Wayne|Mastodons;QUIN||Quinnipiac|Bobcats;RAD||Radford|Highlanders;URI||Rhode Island|Rams;RICE|RICE|Rice|Owls;RICH||Richmond|Spiders;RID||Rider|Broncs;RMU||Robert Morris|Colonials;RUTG|RUTG|Rutgers|Scarlet Knights;SELA||SE Louisiana|Lions;SIUE||SIU Edwardsville|Cougars;SMU|SMU|SMU|Mustangs;SAC|SAC|Sacramento State|Hornets;SHU||Sacred Heart|Pioneers;JOES||Saint Joseph\'s|Hawks;SLU||Saint Louis|Billikens;SMC||Saint Mary\'s|Gaels;SPU||Saint Peter\'s|Peacocks;SHSU|SHSU|Sam Houston|Bearkats;SAM||Samford|Bulldogs;SDSU|SDSU|San Diego State|Aztecs;USD||San Diego|Toreros;SF||San Francisco|Dons;SJSU|SJSU|San José State|Spartans;SCU||Santa Clara|Broncos;SEA||Seattle U|Redhawks;HALL||Seton Hall|Pirates;SIE||Siena|Saints;USA|USA|South Alabama|Jaguars;SC|SC|South Carolina|Gamecocks;SCST||South Carolina State|Bulldogs;UPST||South Carolina Upstate|Spartans;SDAK||South Dakota|Coyotes;SDST||South Dakota State|Jackrabbits;USF|USF|South Florida|Bulls;SEMO||Southeast Missouri State|Redhawks;SIU||Southern Illinois|Salukis;SOU||Southern|Jaguars;USM|USM|Southern Miss|Golden Eagles;SUU||Southern Utah|Thunderbirds;SBU||St. Bonaventure|Bonnies;SJU||St. John\'s|Red Storm;STMN||St. Thomas|Tommies;STAN|STAN|Stanford|Cardinal;SFA||Stephen F. Austin|Lumberjacks;STET||Stetson|Hatters;STO||Stonehill|Skyhawks;STBK||Stony Brook|Seawolves;SYR|SYR|Syracuse|Orange;TCU|TCU|TCU|Horned Frogs;TAR||Tarleton State|Texans;TEM|TEM|Temple|Owls;TNST||Tennessee State|Tigers;TNTC||Tennessee Tech|Golden Eagles;TENN|TENN|Tennessee|Volunteers;TA&M|TA&M|Texas A&M|Aggies;AMCC||Texas A&M-Corpus Christi|Islanders;TEX|TEX|Texas|Longhorns;TXSO||Texas Southern|Tigers;TXST|TXST|Texas State|Bobcats;TTU|TTU|Texas Tech|Red Raiders;CIT||The Citadel|Bulldogs;TOL|TOL|Toledo|Rockets;TOW||Towson|Tigers;TROY|TROY|Troy|Trojans;TULN|TULN|Tulane|Green Wave;TLSA|TLSA|Tulsa|Golden Hurricane;UAB|UAB|UAB|Blazers;UALB||UAlbany|Great Danes;UCD||UC Davis|Aggies;UCI||UC Irvine|Anteaters;UCR||UC Riverside|Highlanders;UCSD||UC San Diego|Tritons;UCSB||UC Santa Barbara|Gauchos;UCF|UCF|UCF|Knights;UCLA|UCLA|UCLA|Bruins;CONN|CONN|UConn|Huskies;UIC||UIC|Flames;ULM|ULM|UL Monroe|Warhawks;UMBC||UMBC|Retrievers;UML||UMass Lowell|River Hawks;UNCA||UNC Asheville|Bulldogs;UNCG||UNC Greensboro|Spartans;UNCW||UNC Wilmington|Seahawks;UNLV|UNLV|UNLV|Rebels;USC|USC|USC|Trojans;UTA||UT Arlington|Mavericks;UTM||UT Martin|Skyhawks;RGV||UT Rio Grande Valley|Vaqueros;UTEP|UTEP|UTEP|Miners;UTSA|UTSA|UTSA|Roadrunners;USU|USU|Utah State|Aggies;UTU||Utah Tech|Trailblazers;UTAH|UTAH|Utah|Utes;UVU||Utah Valley|Wolverines;VCU||VCU|Rams;VMI||VMI|Keydets;VAL||Valparaiso|Beacons;VAN|VAN|Vanderbilt|Commodores;UVM||Vermont|Catamounts;VILL||Villanova|Wildcats;UVA|UVA|Virginia|Cavaliers;VT|VT|Virginia Tech|Hokies;WAG||Wagner|Seahawks;WAKE|WAKE|Wake Forest|Demon Deacons;WASH|WASH|Washington|Huskies;WSU|WSU|Washington State|Cougars;WEB||Weber State|Wildcats;UWF||West Florida|Argonauts;WGA||West Georgia|Wolves;WVU|WVU|West Virginia|Mountaineers;WCU||Western Carolina|Catamounts;WIU||Western Illinois|Leathernecks;WKU|WKU|Western Kentucky|Hilltoppers;WMU|WMU|Western Michigan|Broncos;WICH||Wichita State|Shockers;W&M||William & Mary|Tribe;WIN||Winthrop|Eagles;WIS|WIS|Wisconsin|Badgers;WOF||Wofford|Terriers;WRST||Wright State|Raiders;WYO|WYO|Wyoming|Cowboys;XAV||Xavier|Musketeers;YALE||Yale|Bulldogs;YSU||Youngstown State|Penguins;SFPA||Saint Francis|Red Wolves;USI||Southern Indiana|Screaming Eagles;LIN||Lindenwood|Lions;QUC||Queens University|Royals';
  // every NBA, NFL and NHL team: sport | abbr | place | mascot
  var PRO = 'nba|ATL|Atlanta|Hawks;nba|BOS|Boston|Celtics;nba|BKN|Brooklyn|Nets;nba|CHA|Charlotte|Hornets;nba|CHI|Chicago|Bulls;nba|CLE|Cleveland|Cavaliers;nba|DAL|Dallas|Mavericks;nba|DEN|Denver|Nuggets;nba|DET|Detroit|Pistons;nba|GS|Golden State|Warriors;nba|HOU|Houston|Rockets;nba|IND|Indiana|Pacers;nba|LAC|LA|Clippers;nba|LAL|Los Angeles|Lakers;nba|MEM|Memphis|Grizzlies;nba|MIA|Miami|Heat;nba|MIL|Milwaukee|Bucks;nba|MIN|Minnesota|Timberwolves;nba|NO|New Orleans|Pelicans;nba|NY|New York|Knicks;nba|OKC|Oklahoma City|Thunder;nba|ORL|Orlando|Magic;nba|PHI|Philadelphia|76ers;nba|PHX|Phoenix|Suns;nba|POR|Portland|Trail Blazers;nba|SAC|Sacramento|Kings;nba|SA|San Antonio|Spurs;nba|TOR|Toronto|Raptors;nba|UTAH|Utah|Jazz;nba|WSH|Washington|Wizards;nfl|ARI|Arizona|Cardinals;nfl|ATL|Atlanta|Falcons;nfl|BAL|Baltimore|Ravens;nfl|BUF|Buffalo|Bills;nfl|CAR|Carolina|Panthers;nfl|CHI|Chicago|Bears;nfl|CIN|Cincinnati|Bengals;nfl|CLE|Cleveland|Browns;nfl|DAL|Dallas|Cowboys;nfl|DEN|Denver|Broncos;nfl|DET|Detroit|Lions;nfl|GB|Green Bay|Packers;nfl|HOU|Houston|Texans;nfl|IND|Indianapolis|Colts;nfl|JAX|Jacksonville|Jaguars;nfl|KC|Kansas City|Chiefs;nfl|LV|Las Vegas|Raiders;nfl|LAC|Los Angeles|Chargers;nfl|LAR|Los Angeles|Rams;nfl|MIA|Miami|Dolphins;nfl|MIN|Minnesota|Vikings;nfl|NE|New England|Patriots;nfl|NO|New Orleans|Saints;nfl|NYG|New York|Giants;nfl|NYJ|New York|Jets;nfl|PHI|Philadelphia|Eagles;nfl|PIT|Pittsburgh|Steelers;nfl|SF|San Francisco|49ers;nfl|SEA|Seattle|Seahawks;nfl|TB|Tampa Bay|Buccaneers;nfl|TEN|Tennessee|Titans;nfl|WSH|Washington|Commanders;nhl|ANA|Anaheim|Ducks;nhl|BOS|Boston|Bruins;nhl|BUF|Buffalo|Sabres;nhl|CGY|Calgary|Flames;nhl|CAR|Carolina|Hurricanes;nhl|CHI|Chicago|Blackhawks;nhl|COL|Colorado|Avalanche;nhl|CBJ|Columbus|Blue Jackets;nhl|DAL|Dallas|Stars;nhl|DET|Detroit|Red Wings;nhl|EDM|Edmonton|Oilers;nhl|FLA|Florida|Panthers;nhl|LA|Los Angeles|Kings;nhl|MIN|Minnesota|Wild;nhl|MTL|Montreal|Canadiens;nhl|NSH|Nashville|Predators;nhl|NJ|New Jersey|Devils;nhl|NYI|New York|Islanders;nhl|NYR|New York|Rangers;nhl|OTT|Ottawa|Senators;nhl|PHI|Philadelphia|Flyers;nhl|PIT|Pittsburgh|Penguins;nhl|SJ|San Jose|Sharks;nhl|SEA|Seattle|Kraken;nhl|STL|St. Louis|Blues;nhl|TB|Tampa Bay|Lightning;nhl|TOR|Toronto|Maple Leafs;nhl|UTA|Utah|Mammoth;nhl|VAN|Vancouver|Canucks;nhl|VGK|Vegas|Golden Knights;nhl|WSH|Washington|Capitals;nhl|WPG|Winnipeg|Jets';
  // what people call schools (to the cbb abbreviation). A nickname here beats every other school
  // with the same mascot: "Blue Devils" is Duke, not Central Connecticut.
  var CALIAS = {uconn: 'CONN', 'u conn': 'CONN', zags: 'GONZ', nova: 'VILL', cuse: 'SYR', 'tar heels': 'UNC', heels: 'UNC', unc: 'UNC', bama: 'ALA', 'roll tide': 'ALA',
    mizzou: 'MIZ', 'texas am': 'TA&M', tamu: 'TA&M', aandm: 'TA&M', 'the u': 'MIA', 'miami fl': 'MIA', 'miami florida': 'MIA', 'miami of florida': 'MIA', 'miami ohio': 'M-OH', 'miami oh': 'M-OH',
    'miami of ohio': 'M-OH', 'miami redhawks': 'M-OH', johnnies: 'SJU', 'nc state': 'NCSU', ncsu: 'NCSU', 'north carolina state': 'NCSU', 'n c state': 'NCSU', pitt: 'PITT', cal: 'CAL', 'cal berkeley': 'CAL',
    uva: 'UVA', wahoos: 'UVA', hoos: 'UVA', noles: 'FSU', vols: 'TENN', hogs: 'ARK', huskers: 'NEB', terps: 'MD', buffs: 'COLO', pokes: 'OKST', irish: 'ND', 'fighting irish': 'ND', 'k state': 'KSU',
    kstate: 'KSU', sparty: 'MSU', 'app state': 'APP', 'appalachian state': 'APP', gophers: 'MINN', 'blue devils': 'DUKE', wolverines: 'MICH', gamecocks: 'SC', bearcats: 'CIN', boise: 'BOIS',
    umass: 'MASS', 'st marys': 'SMC', 'saint marys': 'SMC', 'st johns': 'SJU', 'saint johns': 'SJU', penn: 'PENN', 'southern cal': 'USC', 'southern california': 'USC', 'ole miss': 'MISS',
    'ga tech': 'GT', 'va tech': 'VT', 'wazzu': 'WSU', 'cincy': 'CIN', 'hokies': 'VT', 'big red': 'COR', 'seminoles': 'FSU', 'longhorns': 'TEX', 'jayhawks': 'KU', 'hoosiers': 'IU', 'buckeyes': 'OSU',
    'crimson tide': 'ALA', 'sooners': 'OU', 'razorbacks': 'ARK', 'volunteers': 'TENN', 'nittany lions': 'PSU', 'cornhuskers': 'NEB', 'terrapins': 'MD', 'red storm': 'SJU', 'hoyas': 'GTWN'};
  // college abbreviations people type as words, in any case (the rest only in capitals)
  var ABBRW = ['lsu', 'usc', 'ucla', 'tcu', 'smu', 'byu', 'ucf', 'vcu', 'unlv', 'fau', 'fiu', 'utep', 'utsa', 'uab', 'umbc', 'etsu', 'mtsu', 'wku', 'odu', 'ecu', 'usf', 'gcu', 'unm', 'nmsu',
    'usu', 'ttu', 'uga', 'psu', 'osu', 'msu', 'fsu', 'sdsu', 'wvu', 'ksu', 'njit', 'liu', 'siue', 'uic', 'vmi', 'ucsb', 'ucsd', 'uci', 'uncw', 'uncg', 'unca', 'fgcu', 'famu', 'lmu', 'uni',
    'unf', 'uvm', 'uri', 'jmu', 'ndsu', 'bgsu', 'ole miss', 'okst', 'ncat', 'uconn', 'gonz', 'vill', 'unc', 'uk'];
  var ABBR_TO = {psu: 'PSU', osu: 'OSU', msu: 'MSU', ksu: 'KSU', uk: 'UK', usc: 'USC', gonz: 'GONZ', vill: 'VILL', uconn: 'CONN', unc: 'UNC', 'ole miss': 'MISS'};
  // conferences, 2026-27 membership (update on realignment). "both" = basketball and football;
  // a conference with no football list is basketball only.
  var CONF = [
    ['SEC', /\bsec\b|\bsoutheastern conference\b/, 'Alabama,Arkansas,Auburn,Florida,Georgia,Kentucky,LSU,Ole Miss,Mississippi State,Missouri,Oklahoma,South Carolina,Tennessee,Texas,Texas A&M,Vanderbilt', 'both'],
    ['Big Ten', /\bbig ten\b|\bbig 10\b|\bb1g\b/, 'Illinois,Indiana,Iowa,Maryland,Michigan,Michigan State,Minnesota,Nebraska,Northwestern,Ohio State,Oregon,Penn State,Purdue,Rutgers,UCLA,USC,Washington,Wisconsin', 'both'],
    ['Big 12', /\bbig 12\b|\bbig twelve\b|\bbig xii\b/, 'Arizona,Arizona State,Baylor,BYU,Cincinnati,Colorado,Houston,Iowa State,Kansas,Kansas State,Oklahoma State,TCU,Texas Tech,UCF,Utah,West Virginia', 'both'],
    ['ACC', /\bacc\b|\batlantic coast conference\b/, 'Boston College,California,Clemson,Duke,Florida State,Georgia Tech,Louisville,Miami,NC State,North Carolina,Notre Dame,Pittsburgh,SMU,Stanford,Syracuse,Virginia,Virginia Tech,Wake Forest',
      'Boston College,California,Clemson,Duke,Florida State,Georgia Tech,Louisville,Miami,NC State,North Carolina,Pittsburgh,SMU,Stanford,Syracuse,Virginia,Virginia Tech,Wake Forest'],
    ['Big East', /\bbig east\b/, 'Butler,UConn,Creighton,DePaul,Georgetown,Marquette,Providence,St. John\'s,Seton Hall,Villanova,Xavier', ''],
    ['Pac-12', /\bpac ?12\b|\bpac twelve\b|\bpacific 12\b/, 'Boise State,Colorado State,Fresno State,Gonzaga,Oregon State,San Diego State,Texas State,Utah State,Washington State',
      'Boise State,Colorado State,Fresno State,Oregon State,San Diego State,Texas State,Utah State,Washington State'],
    ['Mountain West', /\bmountain west\b|\bmwc\b/, 'Air Force,Grand Canyon,Hawai\'i,Nevada,New Mexico,San José State,UNLV,UTEP,Wyoming',
      'Air Force,Hawai\'i,Nevada,New Mexico,San José State,UNLV,UTEP,Wyoming,Northern Illinois'],
    ['WCC', /\bwcc\b|\bwest coast conference\b/, 'Loyola Marymount,Pacific,Pepperdine,Portland,Saint Mary\'s,San Diego,San Francisco,Santa Clara,Seattle U', ''],
    ['A-10', /\ba ?10\b|\batlantic 10\b|\batlantic ten\b/, 'Davidson,Dayton,Duquesne,Fordham,George Mason,George Washington,La Salle,Loyola Chicago,Rhode Island,Richmond,St. Bonaventure,Saint Joseph\'s,Saint Louis,VCU', ''],
    ['American', /\baac\b|\bamerican athletic\b/, 'Charlotte,East Carolina,Florida Atlantic,Memphis,North Texas,Rice,South Florida,Temple,Tulane,Tulsa,UAB,UTSA,Wichita State',
      'Army,Charlotte,East Carolina,Florida Atlantic,Memphis,Navy,North Texas,Rice,South Florida,Temple,Tulane,Tulsa,UAB,UTSA'],
    ['MAC', /\bmid ?american\b|\bthe mac\b|\bmac (games?|teams?|spreads?|totals?|moneylines?|conference|football|basketball|hoops|picks?|plays?|bets?|action|unders?|overs?|dogs?|favorites?)\b/,
      'Akron,Ball State,Bowling Green,Buffalo,Central Michigan,Eastern Michigan,Kent State,Miami (OH),Northern Illinois,Ohio,Toledo,Western Michigan,Massachusetts',
      'Akron,Ball State,Bowling Green,Buffalo,Central Michigan,Eastern Michigan,Kent State,Miami (OH),Ohio,Toledo,Western Michigan,Massachusetts'],
    ['Sun Belt', /\bsun ?belt\b/, 'App State,Arkansas State,Coastal Carolina,Georgia Southern,Georgia State,James Madison,Louisiana,UL Monroe,Marshall,Old Dominion,South Alabama,Southern Miss,Troy', 'both'],
    ['C-USA', /\bc ?usa\b|\bconference usa\b/, 'Delaware,Florida International,Jacksonville State,Kennesaw State,Liberty,Louisiana Tech,Middle Tennessee,Missouri State,New Mexico State,Sam Houston,Western Kentucky', 'both'],
    ['Ivy League', /\bivy( league)?\b/, 'Brown,Columbia,Cornell,Dartmouth,Harvard,Pennsylvania,Princeton,Yale', ''],
    ['Missouri Valley', /\bmissouri valley\b|\bmvc\b/, 'Belmont,Bradley,Drake,Evansville,Illinois State,Indiana State,Murray State,Northern Iowa,Southern Illinois,UIC,Valparaiso', '']
  ];
  // conferences we do not list yet: said so, never guessed
  var CONF_NO = /\bbig sky\b|\bbig west\b|\bcaa\b|\bcoastal athletic\b|\bhorizon league\b|\bsummit league\b|\bsouthland\b|\bswac\b|\bmeac\b|\bwac\b|\bohio valley\b|\bovc\b|\bpatriot league\b|\bnortheast conference\b|\bmaac\b|\basun\b|\batlantic sun\b|\bamerica east\b|\bsocon\b|\bsouthern conference\b|\bbig south\b/;
  function cnorm(x) { return String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`.]/g, '').replace(/\ba ?& ?t\b/g, 'aandt').replace(/&/g, '').replace(/[^a-z0-9-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  var COLS = null, NKEY = null, NKEYS = null, PROS = null;
  // one index of every way a team is named: key -> [{c: college, kind}] / [{p: pro, kind}]
  function teamDir() {
    if (NKEY) return NKEY;
    COLS = []; PROS = []; NKEY = {};
    var byAb = {};
    D1.split(';').forEach(function (r) { var f = r.split('|'); var c = {cbb: f[0], cfb: f[1], loc: f[2], mascot: f[3], full: f[2] + ' ' + f[3]}; COLS.push(c); byAb[f[0]] = c; });
    function add(k, e) {
      k = cnorm(k); if (k.length < 3 && k !== 'la' && k !== 'uk') return;
      if (/ at$| at /.test(k) && !e.p) return;
      if (k.indexOf('-') >= 0) add(k.replace(/-/g, ' '), e);     // "gardner webb", "arkansas pine bluff"
      var L = NKEY[k] || (NKEY[k] = {col: [], pro: []});
      var arr = e.c ? L.col : L.pro, same = arr.filter(function (x) { return (x.c || x.p) === (e.c || e.p); })[0];
      if (!same) arr.push(e); else if (RANK[e.kind] < RANK[same.kind]) same.kind = e.kind;
    }
    COLS.forEach(function (c) {
      add(c.full, {c: c, kind: 'full'});
      var l = cnorm(c.loc); add(l, {c: c, kind: 'loc'});
      if (/^st /.test(l)) add('saint ' + l.slice(3), {c: c, kind: 'loc'});
      if (/^saint /.test(l)) add('st ' + l.slice(6), {c: c, kind: 'loc'});
      if (/ state$/.test(l)) add(l.replace(/ state$/, ' st'), {c: c, kind: 'loc'});
      add(c.mascot, {c: c, kind: 'mascot'});
    });
    Object.keys(CALIAS).forEach(function (k) { if (byAb[CALIAS[k]]) add(k, {c: byAb[CALIAS[k]], kind: 'alias'}); });
    if (byAb['M-OH']) add('miami', {c: byAb['M-OH'], kind: 'loc'});     // college "Miami" is Miami (FL) or Miami (OH): ask
    ABBRW.forEach(function (a) {
      var A = ABBR_TO[a] || a.toUpperCase(), c = byAb[A] || COLS.filter(function (x) { return x.cfb === A; })[0];
      if (c) add(a, {c: c, kind: 'alias'});
    });
    PRO.split(';').forEach(function (r) {
      var f = r.split('|'), p = {sport: f[0], abbr: f[1], place: f[2], mascot: f[3], full: f[2] + ' ' + f[3]};
      PROS.push(p);
      add(p.full, {p: p, kind: 'full'}); add(p.place, {p: p, kind: 'place'});
      if (p.place === 'LA') add('los angeles ' + p.mascot, {p: p, kind: 'full'});
      if (p.place === 'Tampa Bay') add('tampa', {p: p, kind: 'place'});
      if (p.place === 'Vegas') { add('las vegas', {p: p, kind: 'place'}); add('vegas golden knights', {p: p, kind: 'full'}); }
      if (p.place === 'Las Vegas') add('vegas', {p: p, kind: 'place'});
      if (p.place === 'Golden State') add('golden st', {p: p, kind: 'place'});
      if (p.place === 'Los Angeles' || p.place === 'LA') { add('la', {p: p, kind: 'place'}); add('los angeles', {p: p, kind: 'place'}); }
      if (p.place === 'Utah' && p.sport === 'nhl') add('utah hockey', {p: p, kind: 'full'});
    });
    COLS.byAb = byAb;
    NKEYS = Object.keys(NKEY).sort(function (a, b) { return b.length - a.length; });
    return NKEY;
  }
  var RANK = {full: 0, alias: 0, loc: 1, place: 1, mascot: 2};
  function colByLoc(loc) { teamDir(); var k = cnorm(loc), e = (NKEY[k] || {col: []}).col.filter(function (x) { return x.kind === 'loc' || x.kind === 'alias'; }); return e.length === 1 ? e[0].c : null; }
  // a team plays today (a game still to start on the board) in this sport, by its abbreviation
  function plays(B, sport, abbr, now) {
    if (!abbr) return false;
    return (B || []).some(function (p) { return p.sport === sport && Date.parse(p.start) > now && onTeams(p, [abbr]); });
  }
  var COLLEGE_SP = ['cfb', 'cbb'], FOOTM = /^(rec|rec_yds|rush_yds|pass_yds|pass_td|pass_att|anytime_td|first_td|two_plus_td|three_td|rush_rec_yds|pass_rush_yds)$/, HOOPM = /^(pts|reb|ast|threes|first_basket|q1_total|h1_total)$/;
  // the college sports a request can mean: the ones it named, else what its markets say, else both
  function colSports(s) {
    var named = (s.sports || []).filter(function (x) { return COLLEGE_SP.indexOf(x) >= 0; });
    if (named.length) return named;
    // "duke basketball", "sec football": the sport word next to a college name is its college sport
    var pro = (s.sports || []).map(function (x) { return x === 'nba' ? 'cbb' : x === 'nfl' ? 'cfb' : null; }).filter(Boolean);
    if (pro.length) return pro;
    var mk = s.markets || [];
    if (mk.length && mk.every(function (m) { return FOOTM.test(m); })) return ['cfb'];
    if (mk.length && mk.every(function (m) { return HOOPM.test(m); })) return ['cbb'];
    return ['cfb', 'cbb'];
  }
  function proSports(s) {
    var named = (s.sports || []).filter(function (x) { return x === 'nba' || x === 'nfl' || x === 'nhl'; });
    if (named.length) return named;
    var mk = s.markets || [];
    if (mk.length && mk.every(function (m) { return FOOTM.test(m); })) return ['nfl'];
    if (mk.length && mk.every(function (m) { return HOOPM.test(m); })) return ['nba'];
    return ['nba', 'nfl', 'nhl'];
  }
  // a school as the spec carries it: the abbreviation per college sport, and only the sports it is in
  function schoolPatch(c, sports, B) {
    // every college sport the school plays that the request allows (not just today's): the same words
    // always read the same way, and the answer shows whichever of them has a line
    var sp = sports.filter(function (x) { return x === 'cbb' ? !!c.cbb : !!c.cfb; });
    if (!sp.length) sp = sports.slice(0, 1);
    var tab = {}; sp.forEach(function (x) { tab[x] = [c[x] || c.cbb]; });
    return {team: c[sp[0]] || c.cbb, teams: [], tabbr: tab, school: c.full, sports: sp};
  }
  function colLabel(c, sports, B, now) {
    var on = sports.filter(function (x) { return plays(B, x, c[x] || (x === 'cbb' ? c.cbb : ''), now); });
    return c.full + (on.length ? ' (' + on.map(function (x) { return LG[x]; }).join(', ') + ')' : ' (no game today)');
  }
  function proLabel(p, B, now) { return p.full + ' (' + LG[p.sport] + (plays(B, p.sport, p.abbr, now) ? '' : ', no game today') + ')'; }
  var POWER = null;
  function isPower(c) {
    if (!POWER) {
      POWER = {};
      CONF.slice(0, 5).forEach(function (cf) { cf[2].split(',').forEach(function (l) { var x = colByLoc(l); if (x) POWER[x.cbb] = 1; }); });
      ['GONZ', 'SMC', 'SDSU', 'MEM', 'VCU', 'DAY', 'BOIS', 'UNLV', 'WICH', 'USU', 'ND'].forEach(function (a) { POWER[a] = 1; });
    }
    return !!POWER[c.cbb];
  }
  // the college conference a request names: {name, tabbr: {cbb: [...], cfb: [...]}, sports}
  function confOf(t) {
    for (var i = 0; i < CONF.length; i++) if (CONF[i][1].test(t)) {
      var cf = CONF[i], tab = {}, sp = [];
      [['cbb', cf[2]], ['cfb', cf[3] === 'both' ? cf[2] : cf[3]]].forEach(function (x) {
        if (!x[1]) return;
        tab[x[0]] = x[1].split(',').map(function (l) { var c = colByLoc(l); return c ? (x[0] === 'cfb' ? c.cfb : c.cbb) : null; }).filter(Boolean);
        sp.push(x[0]);
      });
      return {name: cf[0], tabbr: tab, sports: sp, re: cf[1]};
    }
    return null;
  }
  // the sport a team or player is in today: from today's boards first
  function sportsOn(B, test) {
    var o = {}; (B || []).forEach(function (p) { if (test(p)) o[p.sport] = 1; }); return Object.keys(o);
  }
  var NUMW = {one: 1, a: 1, two: 2, couple: 2, double: 2, three: 3, few: 3, triple: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
  var DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function esc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // what people call stars: always the player they mean
  var FAMOUS = {giannis: 'Giannis Antetokounmpo', 'the greek freak': 'Giannis Antetokounmpo', 'greek freak': 'Giannis Antetokounmpo', luka: 'Luka Doncic', lebron: 'LeBron James', bron: 'LeBron James',
    steph: 'Stephen Curry', kd: 'Kevin Durant', wemby: 'Victor Wembanyama', sga: 'Shai Gilgeous-Alexander', shai: 'Shai Gilgeous-Alexander',
    jokic: 'Nikola Jokic', joker: 'Nikola Jokic', embiid: 'Joel Embiid', ant: 'Anthony Edwards', 'ant man': 'Anthony Edwards', ad: 'Anthony Davis',
    'the brow': 'Anthony Davis', dame: 'Damian Lillard', kat: 'Karl-Anthony Towns', jb: 'Jaylen Brown', cp3: 'Chris Paul', harden: 'James Harden',
    booker: 'Devin Booker', tatum: 'Jayson Tatum', mahomes: 'Patrick Mahomes', 'josh allen': 'Josh Allen', lamar: 'Lamar Jackson', burrow: 'Joe Burrow',
    cmc: 'Christian McCaffrey', jj: 'Justin Jefferson', 'ja\'marr': "Ja'Marr Chase", jamarr: "Ja'Marr Chase", ceedee: 'CeeDee Lamb', bijan: 'Bijan Robinson',
    saquon: 'Saquon Barkley', kelce: 'Travis Kelce', henry: 'Derrick Henry', gibbs: 'Jahmyr Gibbs', jalen: 'Jalen Hurts', hurts: 'Jalen Hurts', puka: 'Puka Nacua', 'amon-ra': 'Amon-Ra St. Brown', 'st brown': 'Amon-Ra St. Brown', ovi: 'Alex Ovechkin',
    jefferson: 'Justin Jefferson', mcdavid: 'Connor McDavid', mackinnon: 'Nathan MacKinnon', alcaraz: 'Carlos Alcaraz', sinner: 'Jannik Sinner', djokovic: 'Novak Djokovic'};
  var NFLSTAR = /^(patrick mahomes|josh allen|lamar jackson|joe burrow|christian mccaffrey|justin jefferson|jamarr chase|ceedee lamb|bijan robinson|saquon barkley|travis kelce|derrick henry|jahmyr gibbs|jalen hurts|puka nacua|amon-ra st brown|tyreek hill|davante adams|cooper kupp|jaxon smith-njigba|garrett wilson|josh jacobs|kyren williams|brock bowers|trey mcbride|malik nabers|brian thomas|jayden daniels|caleb williams|cj stroud|bo nix|drake maye|jared goff|baker mayfield|dak prescott)$/;
  function clean(n) { return String(n || '').toLowerCase().replace(/[’']/g, '').replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim(); }
  // everyone a request could name: players with a line today, plus every NBA player on
  // record (data/nba/prior.json) so a star without a line tonight is still recognised.
  // prominence = points a game last season, plus a little for each line Onyx prices on him
  function names(B, P) {
    var C = {};
    function add(name, score, sp, mkt) {
      var k = clean(name); if (!k || k.split(' ').length < 2) return;
      var c = C[k] || (C[k] = {name: name, score: 0, sp: {}, mk: {}});
      c.score += score;
      if (sp) c.sp[sp] = 1;
      if (mkt) c.mk[mkt] = 1;
    }
    // NFL / college players have no points-a-game on file: their lines say how big a part they are
    var YW = {pass_yds: 0.1, rush_yds: 0.25, rec_yds: 0.25, rec: 3};
    (B || []).forEach(function (p) {
      if (p.kind !== 'prop' || !p.name || /_total$/.test(p.mkt) || /\bD\/ST\b|\bdefense\b/i.test(p.name)) return;
      add(p.name, 0.5 + (YW[p.mkt] && p.side === 'over' ? YW[p.mkt] * (p.line || 0) : 0), p.sport, p.mkt);
    });
    (P || []).forEach(function (r) { add(r.n, r.ppg, 'nba'); });
    return C;
  }
  // team names on today's boards (daily_top.write_board adds "tn": the full name): the full
  // name, the school or city (name minus the mascot), and the mascot, each pointing to the
  // abbreviation the board uses. Built once per board.
  var TIDX = null;
  function teamIndex(B) {
    if (TIDX && TIDX.b === B) return TIDX.i;
    var I = {};
    function put(k, abbr, sport, pri) {
      k = clean(k); if (!k || k.length < 4 || NOT_NAMES.test(k) || NICK[k]) return;
      if (!I[k] || I[k].pri > pri) I[k] = {abbr: abbr, sport: sport, pri: pri};
    }
    (B || []).forEach(function (p) {
      if (!p.tn) return;
      var abbr = p.kind === 'prop' ? p.team : (p.team || p.name); if (!abbr) return;
      var w = clean(p.tn).split(' ');
      put(w.join(' '), abbr, p.sport, 0);
      if (w.length >= 2) put(w.slice(0, -1).join(' '), abbr, p.sport, 1);     // "ohio state", "green bay"
      if (w.length >= 3) put(w.slice(-2).join(' '), abbr, p.sport, 2);         // "crimson tide"
      put(w[w.length - 1], abbr, p.sport, 3);                                   // "buckeyes"
      if (w.length >= 3) put(w.slice(0, -2).join(' '), abbr, p.sport, 4);     // "alabama" (from "Alabama Crimson Tide")
    });
    TIDX = {b: B, i: I};
    return I;
  }
  function lev1(a, b) {                    // true when a and b are at most one edit apart (a swap of two letters counts as one)
    if (a === b) return true;
    if (a.length === b.length) { var df = []; for (var q = 0; q < a.length; q++) if (a[q] !== b[q]) df.push(q); if (df.length === 2 && df[1] === df[0] + 1 && a[df[0]] === b[df[1]] && a[df[1]] === b[df[0]]) return true; }
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  var NOT_NAMES = /^(gimme|gimmie|lemme|find|get|got|looking|help|take|think|thoughts|should|pls|plz|yo|build|hit|show|whats|wanna|gonna|tonite|please|need|want|give|can|you|me|my|some|good|best|top|safest|what|about|is|going|his|her|for|the|a|an|and|or|from|with|i|will|wills|rebound|rebounds|assist|catch|rush|pass|likely|likes|half|halves|quarter|quarters|scorer|scorers|rusher|rushers|receiver|receivers|passer|leading|leader|top|round|robin|basket|bucket|touchdown|touchdowns|totals|chance|chances|safest|lock|locks|tonight|tomorrow|night|slate|card|board|sharp|steam|juice|payout|pays|winner|winners|underdog|underdogs|favorite|favorites|again|every|other|their|there|these|those|about|around|would|could|should|shot|shots|star|stars|over|under|overs|unders|most|plus|game|games|best|safe|safest|team|teams|with|tonight|today|points|value|parlay|legs|leg|lock|bets|plays|picks|money|line|lines|odds|total|totals|spread|score|scores|win|wins|first|anytime|rebounds|assists|yards|receptions|sunday|monday|tuesday|wednesday|thursday|friday|saturday|week|weekend|give|what|which|who|like|need|want|good|more|less|than|from|this|that|the|and|for|nba|nfl|nhl|tennis|college|max|min|maximum|minimum|longshots|dogs|favorites|fade|stack|sgp|props|prop|player|players|ticket|double|triple|edge|bet|play|pick|side|sides|only|just|ats|ml|moneyline|moneylines|spreads|run|runs|puck|goal|goals|alt|alts|alternate|ladder|live|hedge|cover|covers|dog|fav|favs|chalk|lean|leans|model|onyx|parlays|sgps|plus|minus|even|safe|hammer|nuke|banker|bankers|longshot|sleeper|sleepers|fades|tail|tails|boost|boosts|power|prime|primetime|early|late|slate|main|night|afternoon|morning|home|away|road|big|small|low|high|long|short|hot|cold|streak|streaks|trend|trends|units|unit|bankroll|book|books|price|prices|number|numbers|key|keys|half|full|period|periods|inning|innings|set|sets|match|matches|fight|fights|card|cards|round|rounds|teaser|teasers|correlated|stacked|same|different|any|all|both|each|either|neither|one|two|three|four|five|six|seven|eight|nine|ten|twelve|dozen|couple|few|some|many|much|pair|guard|guards|center|centers|forward|forwards|wing|wings|qb|qbs|rb|rbs|wr|wrs|te|tes|upset|upsets|value|sharp|sharpest|night|monday|sunday)$/;
  function findPlayer(t, C, mk) {
    var keys = Object.keys(C), words = t.trim().split(/\s+/);
    // two players share a name ("george", "drake"): the one with a line in the asked market today wins,
    // then anyone with a line today, then the more prominent (11/2: 15,000 generated questions)
    var tier = function (k) { var c = C[k], m = c.mk || {}; return ((mk || []).some(function (x) { return m[x]; }) ? 2 : 0) + (Object.keys(m).length ? 1 : 0); };
    var best = function (cands) { return cands.sort(function (a, b) { return (tier(b) - tier(a)) || (C[b].score - C[a].score); })[0]; };
    // 1. a full name ("Luka Garza" is Garza, even though "Luka" alone is Doncic)
    var full = keys.filter(function (k) { return t.indexOf(' ' + k + ' ') >= 0; });
    if (full.length) return C[best(full)].name;
    // 3. every other way a name is typed, scored by how much of it matches: each name part said
    // exactly counts 2 (the last name a little more), one letter off counts 1. "Mason talor" is Mason
    // Taylor (first exact + last close) over Jordan Mason (last exact only); "caleb dougllas" is Caleb
    // Douglas over DeMario Douglas. A bare first name still finds the most prominent player with it.
    // Ties go to a line in the asked market today, then a line today, then prominence. (11/2: 15,000
    // generated questions)
    var ok = function (w) { return w.length >= 3 && !NOT_NAMES.test(w) && !NICK[w] && !NICK[w.replace(/s$/, '')]; };
    var W = words.filter(ok), fit = {}, typed = null;
    keys.forEach(function (k) {
      var parts = k.split(' '), sc = 0, exact = 0;
      parts.forEach(function (n, pi) {
        var last = pi === parts.length - 1;
        if (n.length < 2) return;
        if (W.some(function (w) { return w === n || (last && w === n + 's'); })) {
          // a last name typed after a different first name is a different player ("jeremiah smith" is
          // not Geno Smith): remember the name as typed instead
          var at = words.indexOf(n) >= 0 ? words.indexOf(n) : words.indexOf(n + 's'), prev = at > 0 ? words[at - 1] : '';
          if (last && parts.length > 1 && prev && ok(prev) && prev.length >= 3 && prev !== parts[0] && !lev1(prev, parts[0]) && !W.some(function (w) { return w === parts[0]; })) { typed = prev + ' ' + n; return; }
          sc += last ? 2.1 : 2; exact++;
        }
        else if (n.length >= 5 && W.some(function (w) { return w.length >= 5 && lev1(w, n); })) sc += 1;
      });
      var l = parts[parts.length - 1];
      if (exact === 1 && sc < 3 && parts.length && W.indexOf(l) >= 0 && (l.length < 3)) return;
      if (sc >= 2) fit[k] = sc;
    });
    var fk = Object.keys(fit), top0 = fk.length ? Math.max.apply(null, fk.map(function (k) { return fit[k]; })) : 0;
    // 2. a nickname or a star's one word name, unless more of another player's name was typed
    // ("jalen" is Jalen Hurts, "jalen naillor" is Jalen Nailor)
    if (top0 < 3) {
      var fam = Object.keys(FAMOUS).sort(function (a, b) { return b.length - a.length; });
      for (var f = 0; f < fam.length; f++) if (new RegExp('(^|\\s)' + esc(fam[f]) + 's?(\\s|$)').test(t)) return FAMOUS[fam[f]];
    }
    if (fk.length) {
      var top = Math.max.apply(null, fk.map(function (k) { return fit[k]; }));
      return C[best(fk.filter(function (k) { return fit[k] === top; }))].name;
    }
    // a full name nobody on today's boards has: keep it, so the answer can say they have no game today
    if (typed && !fk.some(function (k) { return fit[k] >= 2; })) return typed.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    // 4. one name part one letter off and nothing else ("jokick"): the most prominent such player
    var loose = keys.filter(function (k) { return k.split(' ').some(function (n) { return n.length >= 5 && W.some(function (w) { return w.length >= 5 && lev1(w, n); }); }); });
    if (loose.length) return C[best(loose)].name;
    return null;
  }

  // pro nicknames two leagues share: the one playing today, or ask
  var DUPN = {jets: {nfl: 'NYJ', nhl: 'WPG'}, kings: {nba: 'SAC', nhl: 'LA'}, panthers: {nfl: 'CAR', nhl: 'FLA'}};
  var COMMONW = /^(pacific|southern|liberty|temple|troy|rice|brown|howard|campbell|drake|lamar|marshall|wagner|bryant|presbyterian|columbia|monmouth|charleston|oakland|omaha|maine|vermont|montana|idaho|houston christian|green|ball|state|tech|central|eastern|western|northern|southern|north|south|east|west|saint|st|university|college|valley|city|bay|beach|coast|christian|mercy|island|long island|holy cross|sacred heart|high point)$/;
  // the teams a request names (11/2): every college and pro team by full name, school, city, alias,
  // abbreviation, and pro nickname, longest name first ("georgia tech" is not Georgia, "boston
  // college" is not Boston, "miami hurricanes" is not Carolina). A pro city or nickname is the pro
  // team unless the request is about college; a college name is never a pro team. Two schools (or
  // two pro teams playing today) with the same name: ask which (ambig), never guess.
  var RAWQ = '';
  function readTeams(t, s, B, colSig) {
    teamDir();
    var now = Date.now(), tPlayer = ' ' + cnorm(t) + ' ', tq = tPlayer.replace(/-/g, ' ');
    // a possessive, as typed ("north dakota state's pace", "little rock's"): the name before the 's
    var posq = ' ' + cnorm(String(RAWQ).replace(/['’]s\b/gi, '')).replace(/-/g, ' ') + ' ';
    var PCall = names(B, PRIOR), PW = {};
    // a full player name wins over a team word inside it ("LaMelo Ball", "PJ Washington", "Jalen Green")
    Object.keys(PCall).forEach(function (k) {
      var c = PCall[k], kk = ' ' + cnorm(k).replace(/-/g, ' ') + ' ';
      // only the last name: "butler points" is Jimmy Butler, but "duke basketball" is the Blue Devils even
      // with a Duke Watson on the slate (11/4: a first name took Duke away from the school)
      if (Object.keys(c.mk || {}).length || c.score >= 8) {
        var np = cnorm(k).split(' ').filter(function (w) { return !/^(jr|sr|ii|iii|iv|v)$/.test(w); }), lw = np[np.length - 1];
        if (lw && lw.length >= 4) PW[lw] = 1;
      }
      if (k.indexOf(' ') > 0 && tq.indexOf(kk) >= 0) tq = tq.split(kk).join(' ' + kk.trim().replace(/[a-z0-9]/g, '_') + ' ');
    });
    var mk = s.markets || [], gameMk = mk.length && mk.every(function (m) { return /^(spread|total|ml)$/.test(m); });
    var mask = function (at, len) { var m = new Array(len + 1).join('_'); tq = tq.slice(0, at + 1) + m + tq.slice(at + 1 + len); tPlayer = tPlayer.slice(0, at + 1) + m + tPlayer.slice(at + 1 + len); };
    var found = [];
    for (var i = 0; i < NKEYS.length; i++) {
      var k = NKEYS[i]; if (k.length + 2 > tq.length) continue;
      var at = tq.indexOf(' ' + k + ' '), len = k.length;
      var E = NKEY[k];
      if (at < 0 && k.length >= 4 && ((k.indexOf(' ') < 0 && !/s$/.test(k) && !E.pro.length) || posq.indexOf(' ' + k + ' ') >= 0)) { at = tq.indexOf(' ' + k + 's '); len = k.length + 1; }     // "kentuckys pace", "dukes", "oranges pace"
      if (at < 0) continue;
      var typed = tq.substr(at + 1, len), single = k.indexOf(' ') < 0, nick = !!(NICK[typed] || NICK[k] || NICK[k + 's'] || NICK[k.replace(/s$/, '')]);
      // a player's stat on a word that is also his name ("washington rebounds" is PJ Washington): the player
      if (single && PW[k] && mk.length && mk.every(function (m) { return !/^(spread|total|ml)$/.test(m); }) && !colSig) continue;
      if (E.col.length && !E.pro.length && !colSig) {
        if (nick) continue;                                             // "bruins", "panthers", "ducks": the pro team, read below
        if (single && PW[k] && !gameMk) continue;                      // "butler points" is Jimmy Butler, "butler spread" the Bulldogs
        if (COMMONW.test(k) && !gameMk) continue;                      // everyday words need "college" or a game line
      }
      if (!E.col.length && !E.pro.length) continue;
      mask(at, len);
      found.push({k: k, at: at, col: E.col, pro: E.pro});
      if (found.length > 4) break;
    }
    found.sort(function (a, b) { return a.at - b.at; });
    // a plain college name in the request ("tennessee vols", "duke and houston") makes its place names college too
    if (!colSig && found.some(function (f) { return f.col.length && !f.pro.length && f.col.every(function (e) { return e.kind !== 'mascot'; }); })) colSig = true;
    var out = {teams: [], tab: {}, sports: [], school: null, ambig: null, colAlt: [], tPlayer: tPlayer, tTeam: tq, schoolList: [], names: []};
    var addTeam = function (abbr, sp, ab2) { if (out.teams.indexOf(abbr) < 0) out.teams.push(abbr); if (out.sports.indexOf(sp) < 0) out.sports.push(sp); var L = out.tab[sp] || (out.tab[sp] = []); if (L.indexOf(ab2 || abbr) < 0) L.push(ab2 || abbr); };
    var playsAny = function (c, sp) { return sp.some(function (x) { return plays(B, x, x === 'cfb' ? c.cfb : c.cbb, now); }) ? 1 : 0; };
    found.forEach(function (f) {
      if (f.col.length && (colSig || !f.pro.length)) {
        var best = Math.min.apply(null, f.col.map(function (e) { return RANK[e.kind]; }));
        var sp = colSports(s), C = f.col.filter(function (e) { return RANK[e.kind] === best; }).map(function (e) { return e.c; })
          .filter(function (c) { return sp.some(function (x) { return x === 'cbb' ? c.cbb : c.cfb; }); });
        if (!C.length) return;
        if (C.length === 1) {
          if (out.schoolList.indexOf(C[0]) >= 0) return;          // "UNC Tar Heels", "Gonzaga Zags": one school
          out.schoolList.push(C[0]);
          var pt = schoolPatch(C[0], sp, B);
          pt.sports.forEach(function (x) { addTeam(pt.tabbr[x][0], x); });
          if (!out.school) out.school = C[0].full; else out.school += ', ' + C[0].full;
          return;
        }
        // several schools go by this name: the ones playing today first, then the big programs
        // (the big programs first, playing today first within each; up to 8 buttons)
        var pw = function (c) { return isPower(c) ? 1 : 0; };
        C.sort(function (a, b) { return (pw(b) * 4 + playsAny(b, sp) * 3 - pw(a) * 4 - playsAny(a, sp) * 3) || (a.full < b.full ? -1 : 1); });
        if (!out.ambig) out.ambig = {word: f.k, n: C.length, opts: C.slice(0, 8).map(function (c) { return {label: colLabel(c, sp, B, now), patch: schoolPatch(c, sp, B)}; })};
        return;
      }
      var P = f.pro.map(function (e) { return e.p; }), psp = proSports(s), P2 = P.filter(function (p) { return psp.indexOf(p.sport) >= 0; });
      if (P2.length) P = P2;
      // a college that shares the place: offered if the pro team has no game ("Houston" when only the Cougars play)
      f.col.forEach(function (e) { if (e.kind !== 'mascot' && out.colAlt.indexOf(e.c) < 0) out.colAlt.push(e.c); });
      var live = P.filter(function (p) { return plays(B, p.sport, p.abbr, now); });
      var pick = P.length === 1 ? P[0] : live.length === 1 ? live[0] : live.length ? null : P[0];
      if (pick) { addTeam(pick.abbr, pick.sport); out.names.push(pick.full); return; }
      if (!out.ambig) {
        var csp = colSports(s);
        out.ambig = {word: f.k, opts: live.map(function (p) { return {label: proLabel(p, B, now), patch: {team: p.abbr, teams: [], tabbr: (function () { var o = {}; o[p.sport] = [p.abbr]; return o; })(), sports: [p.sport], school: null}}; })
          .concat(f.col.filter(function (e) { return e.kind !== 'mascot'; }).map(function (e) { return {label: colLabel(e.c, csp, B, now), patch: schoolPatch(e.c, csp, B)}; })).slice(0, 6)};
      }
    });
    // pro nicknames ("lakers", "jets", "canes"), one or several
    var keys = Object.keys(NICK).sort(function (a, b) { return b.length - a.length; });
    for (var j = 0; j < keys.length; j++) {
      var nk = keys[j], at2 = tq.indexOf(' ' + nk + ' ');
      if (at2 < 0) continue;
      mask(at2, nk.length);
      var lg = SPORT_OF_NICK[nk], ab = NICK[nk], named = (s.sports || []).filter(function (x) { return /^(nba|nfl|nhl)$/.test(x); });
      if (DUPN[nk]) {
        var D = DUPN[nk], opts = Object.keys(D).filter(function (x) { return !named.length || named.indexOf(x) >= 0; });
        if (nk === 'jets' && /hockey|winnipeg/.test(t)) opts = ['nhl'];
        var liveD = opts.filter(function (x) { return plays(B, x, D[x], now); });
        if (opts.length === 1) { lg = opts[0]; ab = D[lg]; }
        else if (liveD.length === 1) { lg = liveD[0]; ab = D[lg]; }
        else if (liveD.length > 1 && !out.ambig && !out.teams.length) {
          out.ambig = {word: nk, opts: liveD.map(function (x) { var p = PROS.filter(function (y) { return y.sport === x && y.abbr === D[x]; })[0]; var o = {}; o[x] = [D[x]];
            return {label: proLabel(p, B, now), patch: {team: D[x], teams: [], tabbr: o, sports: [x], school: null}}; })};
          continue;
        }
      } else if (named.length && named.indexOf(lg) < 0) continue;
      addTeam(ab, lg);
      var pf = PROS.filter(function (y) { return y.sport === lg && y.abbr === ab; })[0]; if (pf) out.names.push(pf.full);
    }
    out.tPlayer = tPlayer; out.tTeam = tq;
    return out;
  }
  function localSpec(q, B) {
    RAWQ = q;
    q = String(q).replace(/[.\s]+$/, '');                 // "without Cowboys." (11/6)
    var t = ' ' + q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[?!,()]/g, ' ').replace(/\s+/g, ' ') + ' ';
    // the common misspellings (tested: tools/ask_bigcorpus.py), and shorthand
    t = t.replace(/\bparly\b|\bparley\b|\bparlya\b/g, 'parlay').replace(/\bpasing\b/g, 'passing').replace(/\brec[ie]{2}ving\b/g, 'receiving')
         .replace(/\brusing\b|\brushin\b/g, 'rushing').replace(/\breboun?ds?\b|\brebouds\b/g, 'rebounds').replace(/\basists?\b/g, 'assists')
         .replace(/\brecep[a-z]*ons?\b/g, 'receptions').replace(/\bpionts\b|\bponts\b/g, 'points').replace(/\b(2night|2nite|tonite|tonigh|tonght|tnight)\b/g, 'tonight').replace(/\bmoney ?l[a-z]?nes?\b/g, 'moneyline').replace(/\bt[ou]{1,2}ch ?d[a-z]{0,2}wns?\b/g, 'touchdown').replace(/\bbasketbal\b/g, 'basketball')
         .replace(/\bhocky\b|\bhockee\b/g, 'hockey').replace(/\bspr(?:a|e|ae|ee|aa)ds?\b/g, function (m) { return /s$/.test(m) ? 'spreads' : 'spread'; }).replace(/\btouchdwns?\b|\btouchdowns?\b/g, function (m) { return /s$/.test(m) ? 'touchdowns' : 'touchdown'; })
         .replace(/\brec (yards|yds)\b/g, 'receiving yards').replace(/\brush (yards|yds)\b/g, 'rushing yards').replace(/\bpass (yards|yds)\b/g, 'passing yards');
    // what they do NOT want: "no kelce", "without lebron", "except the lakers". Taken out of the
    // request before anything else reads it (11/2: each of these read as the opposite)
    var EXW = [];
    // 11/6 (Jordan: "if you say no that's actually the only thing it focuses on": "no first basket scorers,
    // parlay of +2000" built a first-basket parlay): a market after no / without / except is left out
    var XMK = [], XSIDE = null, XPROPS = false, XLINES = false;
    var NEG = '(?<!(?:@|\\bvs\\.?|\\bv|\\bat)\\s)\\b(?:no|not|without|except|excluding|exclude|other than|besides|not including|leave out|skip|but not|none of|avoid|minus|stay away from|nothing with)\\s+(?:any\\s+)?(?:the\\s+)?(?:more\\s+)?';
    t = t.replace(new RegExp(NEG + '((?:player\\s+)?props?|game lines?|main lines?|overs|unders|point spr[a-z]*|spr[ae]+ds?|against the spread|ats|o\\/u|over[\\s-]?unders?|to win|win outright|winners?|rebs|reb|dimes|ast|anytime touchdowns?|anytime tds?|rec yards|rush yards|pass yards|catches|(?:(?:1st|first|anytime|2\\+?|two)\\s*)?(?:basket|bucket|td|tds|touchdowns?|quarter|qtr|half)(?:\\s*(?:scorers?|totals?|bets?|props?|picks?))?|spreads?|totals?|moneylines?|money lines?|ml|rebounds?|boards|assists?|dimes|points?|pts|threes|3s|receptions?|catches|(?:receiving|rushing|passing|rec|rush|pass)\\s*(?:yards|yds)|(?:receiving|rushing|passing)|td scorers?|scorers?)\\b', 'g'), function (m, ph) {
      if (/^(?:player\s+)?props?$/.test(ph)) XPROPS = true;
      else if (/^(game|main) lines?$/.test(ph)) XLINES = true;
      else if (ph === 'overs') XSIDE = 'under';
      else if (ph === 'unders') XSIDE = 'over';
      else {
        var hit = false, ph2 = ' ' + ph + ' ';
        for (var wi = 0; wi < WORDS.length; wi++) if (WORDS[wi][0].test(ph2)) { XMK.push(WORDS[wi][1]); hit = true; break; }
        if (!hit && /^(td|tds|touchdowns?|td scorers?|scorers?)$/.test(ph)) { XMK.push('anytime_td'); hit = true; }
        if (!hit) return m;
      }
      return ' ';
    });
    t = t.replace(/(?<!(?:@|\bvs\.?|\bv|\bat)\s)\b(no|without|except|excluding|exclude|other than|besides|not including|leave out|skip|but not|nothing (?:on|from)|none of|avoid|minus)\s+(the\s+)?([a-z0-9][a-z0-9.\-&]*(?:\s+[a-z0-9&][a-z0-9.\-&]*){0,3})/g, function (m, w, the, ph) {
      var ws = ph.trim().split(' '), first = ws[0];
      // a player's full name before any school ("no Xavier Worthy" is the receiver, not Xavier; 11/6)
      if (ws.length >= 2) { var NM0 = names(B, PRIOR);
        for (var pw = Math.min(3, ws.length); pw >= 2; pw--) if (NM0[clean(ws.slice(0, pw).join(' '))]) { EXW.push(ws.slice(0, pw).join(' ')); return ' ' + ws.slice(pw).join(' ') + ' '; } }
      // a team's whole name ("no duke blue devils", "except the kansas city chiefs", "no long beach state")
      teamDir();
      for (var nw0 = Math.min(4, ws.length); nw0 >= 1; nw0--) {
        var cand0 = ws.slice(0, nw0).join(' '), ck0 = cnorm(cand0).replace(/-/g, ' ');
        if (the && NKEY['the ' + ck0]) { cand0 = 'the ' + cand0; ck0 = 'the ' + ck0; }
        if ((NKEY[ck0] && (NKEY[ck0].col.length || NKEY[ck0].pro.length)) || NICK[ck0]) { EXW.push(cand0); return ' ' + ws.slice(nw0).join(' ') + ' '; }
      }
      // a player's full name ("no Max Christie": "max" alone is a price word)
      if (ws.length >= 2) { var NM = names(B, PRIOR); if (NM[clean(ws.slice(0, 2).join(' '))]) { EXW.push(ws.slice(0, 2).join(' ')); return ' ' + ws.slice(2).join(' ') + ' '; } }
      if (NOT_NAMES.test(first) || /^(juice|odds|worse|longer|shorter|more|less|higher|lower|bigger|than|over|under|plus|minus|favou?rites?|dogs?|underdogs?|chalk|props?|parlays?|legs?|price|prices|vig|negative|longshots?|ties?|overtime|ot|live|alt|alts|one|two|three|four|five|six|risk|loss|losers?|repeats?|duplicates?|same|bad|sweat|sweats|limit|limits|more)$/.test(first)) return m;
      // else a player (two words)
      EXW.push(ws.slice(0, 2).join(' ')); return ' ' + ws.slice(2).join(' ') + ' ';
    }).replace(/\s+/g, ' ');
    var s = {intent: 'list', count: null, sports: [], markets: [], side: 'any', min_price: null, max_price: null, min_conf: null,
             min_edge: null, player: null, team: null, sort: 'conf', one_per_game: true, when: null, summary: ''};
    if (XMK.length) s.xmk = XMK.filter(function (m, i) { return XMK.indexOf(m) === i; });
    if (XMK.indexOf('anytime_td') >= 0 && s.xmk.indexOf('first_td') < 0) s.xmk.push('first_td', 'two_plus_td', 'two_td', 'three_td');
    if (XPROPS) s.no_props = true;
    if (XLINES) s.props_only = true;
    if (XSIDE) s.side = XSIDE;
    // what kind of answer
    if (/sgp ?(\+|plus)(?!\s*(odds|money|\d))/.test(t)) s.intent = 'parlay';
    else if (/\bsgp\b|same[\s-]*game|correlated|stack/.test(t)) s.intent = 'sgp';
    else if (/parlay|\blegs?\b|legger|(?<!lottery )ticket|\bslip\b|\bcombo\b|\bdouble\b|\btriple\b|\bteaser\b|\baccas?\b|\baccumulators?\b|\bmultis?\b(?![\s-]?tds?\b|[\s-]?touchdown)|\b\d{1,2}[\s-]*folds?\b|\btrebles?\b/.test(t)) s.intent = 'parlay';
    // a round robin: "round robin 4 picks by 2s", "rr of 5 by 3s"
    var rr = t.match(/\b(round[\s-]*robin|\brr\b)/);
    if (rr) {
      s.intent = 'rr';
      var by = t.match(/\bby\s*(\d|twos|threes|fours|2s|3s|4s)\b/) || t.match(/\b(\d)s\b/);
      s.rr_size = by ? ({twos: 2, threes: 3, fours: 4})[by[1]] || parseInt(by[1], 10) : 2;
    }
    // a payout target: "parlay that pays +500", "to win around +1000", "a +300 parlay"
    var tg = t.match(/\b(pays?|paying|payout( of)?|to (win|pay)|around|about|returns?)\s*\+?(\d{3,5})\b/) || t.match(/\+(\d{3,5})\s+(?:[a-z]+\s+){0,3}?(parlay|parlays|ticket|sgp|legger)\b/);   // 11/6: "+1000 cfb parlay three legs"
    var tgv = tg ? +(tg.slice(1).filter(function (x) { return x && /^\d+$/.test(x); })[0]) : null;
    // "pays 10 to 1", "a 20-1 longshot parlay": that many times the stake in profit
    var to1 = !tgv && t.match(/\b(\d{1,3})\s*(?:to|-|:)\s*1\b/);
    if (to1 && +to1[1] >= 2 && /parlay|ticket|pays?|payout|odds|longshot|legger|legs?\b/.test(t)) tgv = +to1[1] * 100;
    // "turn $10 into $100", "$20 to win $100", "bet 10 to win 50 bucks": the payout those dollars mean
    var into = !tgv && t.match(/\$?\s*(\d{1,5})\s*(?:dollars|bucks)?\s*(?:into|to make|to turn into)\s*\$?\s*(\d{1,6})/);
    if (into && +into[2] > +into[1]) { tgv = Math.round((+into[2] / +into[1] - 1) * 100); if (s.intent === 'list') s.intent = 'parlay'; s.target_price = tgv; }
    var towin = !tgv && /\$|dollars|bucks/.test(t) && t.match(/\$?\s*(\d{1,5})\s*(?:dollars|bucks)?\s*to win\s*\$?\s*(\d{1,6})/);
    if (towin && +towin[2] > 0) { tgv = Math.round(+towin[2] / +towin[1] * 100); if (s.intent === 'list') s.intent = 'parlay'; s.target_price = tgv; }
    // "to win 3x", "a 5x parlay": that many times the stake back, so 3x is +200
    var mx3 = !tgv && t.match(/\b(\d{1,2})\s*x\b/);
    if (mx3 && +mx3[1] >= 2) tgv = (+mx3[1] - 1) * 100;
    if (tgv && /parlay|ticket|legs?\b|legger|sgp|round/.test(t)) { if (s.intent === 'list') s.intent = 'parlay'; s.target_price = tgv; }
    // how many
    var tC = t.replace(/\b(pac|big|atlantic)[\s-]?(10|12)\b/g, ' ').replace(/\ba[\s-]?10\b(?!\s*(leg|legs|legger|picks?|plays?|bets?|team|teams|man|folds?|way))/g, ' ').replace(/\b\d{1,3}\s*(?:to|-|:)\s*1\b/g, ' ').replace(/\$?\s*\d+\s*(?:dollars|bucks)?\s*(?:into|to make|to win)\s*\$?\s*\d+/g, ' ');
    var n = tC.match(/\b(\d{1,2})[\s-]*(leg|legs|legger|picks?|plays?|players?|bets?|team|man|teamer|folds?|way)\b/) || tC.match(/\b(?:top|best|safest|surest)\s*(\d{1,2})\b(?!\s*(points|rebounds|assists|yards|receptions|%|percent))/)
      || tC.match(/\b(\d{1,2})\s+(?:best|safest|top|surest)\b/)
      || tC.match(/\bparlay of (\d{1,2})\b/) || tC.match(/\b(\d{1,2})\s+(nba|nfl|nhl|college|tennis|hockey|basketball|football|hoops|ncaab|ncaaf|cbb|cfb|pro)\b(?!\s*(points|rebounds|assists|yards|receptions))/);
    var nw = tC.match(/\b(two|three|four|five|six|seven|eight|nine|ten|couple|few)( of)?[\s-]*(leg|legs|legger|picks?|plays?|bets?|team|man)\b/)
      || tC.match(/\b(?:parlay|ticket|sgp) of (two|three|four|five|six|seven|eight|nine|ten)\b/)
      || tC.match(/\b(?:top|best|safest|surest|give me|gimme)\s+(two|three|four|five|six|seven|eight|nine|ten)\b/)
      || tC.match(/\b(two|three|four|five|six|seven|eight|nine|ten)\s+(?:best|safest|top|surest|most likely)\b/);   // 11/6: "top three nba spreads" 
    if (!n && !nw) {
      var n2 = tC.match(/\b(\d{1,2})\s+(?:\w+\s+){0,2}?(overs|unders|props|plays|picks|bets|players|teams|sides|dogs|favorites|favs|scorers|rebounds|assists|points|receptions|touchdowns|tds|totals|spreads|parlay|sgp|legger)\b/);
      if (n2 && +n2[1] <= 12 && !/\b\d{1,2}\s+(points|rebounds|assists|receptions|tds|touchdowns)\s+(or|and|in|a|per)\b/.test(t)) n = [n2[0], n2[1]];
      else if (/\b(a )?pair of\b/.test(t)) nw = [null, 'two'];
      else if (/\b(one|a single|1)\s+(\w+\s+){0,2}?(bet|play|pick|prop|leg)\b(?!s)/.test(t)) nw = [null, 'one'];
    }
    s.count_set = !!(n || nw);
    s.count = n ? +n[1] : nw ? NUMW[nw[1]] : /\bdouble\b/.test(t) && s.intent === 'parlay' ? 2 : /\b(triple|treble)\b/.test(t) && s.intent === 'parlay' ? 3 : null;
    // which sport
    // college basketball and college football by name (11/2: "college basketball" was read as
    // unsupported and "college" alone as football); "college" alone is both, unless a market says which
    var tS = t.replace(new RegExp(CBBW.source, 'g'), ' ').replace(new RegExp(CFBW.source, 'g'), ' ');
    var genCol = /\bcollege\b|\bncaa\b|\bcollegiate\b|\bd1\b|\bdivision (1|i)\b/.test(tS);
    var hoopW = /\bnba\b|basketball|hoops|\bb-?ball\b/.test(tS), footW = /\bnfl\b|pro football|\bfootball\b/.test(tS);
    if (CBBW.test(t) || (genCol && hoopW && !/\bnba\b/.test(tS))) s.sports.push('cbb');
    if (CFBW.test(t) || (genCol && footW && !/\bnfl\b|pro football/.test(tS))) s.sports.push('cfb');
    if (hoopW && !(genCol && !/\bnba\b/.test(tS))) s.sports.unshift('nba');
    if (footW && !(genCol && !/\bnfl\b|pro football/.test(tS)) && s.sports.indexOf('nfl') < 0) s.sports.splice(s.sports.indexOf('nba') >= 0 ? 1 : 0, 0, 'nfl');
    var genOnly = genCol && !s.sports.some(function (x) { return x === 'cfb' || x === 'cbb'; });
    var cfx = confOf(' ' + cnorm(t).replace(/-/g, ' ') + ' ');
    var colSig = genCol || s.sports.indexOf('cfb') >= 0 || s.sports.indexOf('cbb') >= 0 || !!cfx;
    if (/\bnhl\b|hockey/.test(t)) s.sports.push('nhl');
    if (/tennis|\batp\b|\bwta\b/.test(t)) s.sports.push('tennis');
    // which markets
    for (var i = 0; i < WORDS.length; i++) if (WORDS[i][0].test(t) && s.markets.indexOf(WORDS[i][1]) < 0) {
      // "parlay of two td scorers" is two legs of TD scorers, not 2+ touchdowns ("2+ td scorers" still is)
      if (WORDS[i][1] === 'two_plus_td' && /\b(2|two)\s+(td|tds|touchdown)\s+scorers\b/.test(t) && !/\+/.test(t) && /\b(parlay|parly|legs?|legger|of)\b/.test(t)) continue;
      if (WORDS[i][1] === 'anytime_td' && (s.markets.indexOf('two_plus_td') >= 0 || s.markets.indexOf('three_td') >= 0 || s.markets.indexOf('first_td') >= 0 || s.markets.indexOf('pass_td') >= 0)) continue;
      if (WORDS[i][1] === 'pass_yds' && s.markets.indexOf('pass_td') >= 0 && !/\bpass(ing)? (yards|yds)\b/.test(t)) continue;
      if (/^(pass_yds|rush_yds|rec_yds)$/.test(WORDS[i][1]) && (s.markets.indexOf('rush_rec_yds') >= 0 || s.markets.indexOf('pass_rush_yds') >= 0)) continue;
      if (WORDS[i][1] === 'pass_yds' && s.markets.indexOf('pass_att') >= 0 && !/\byards\b|\byds\b/.test(t)) continue;
      if (WORDS[i][1] === 'q1_total' && (s.markets.indexOf('first_td') >= 0 || s.markets.indexOf('first_basket') >= 0)) continue;
      // "total receptions", "total points for Jokic": a player's total, not the game total
      if (WORDS[i][1] === 'total' && /\btotal (receptions|catches|yards|rushing|passing|receiving|rebounds|assists|boards|dimes|tds|touchdowns|points|pts|bases|hits)\b/.test(t)) continue;
      if (WORDS[i][1] === 'pts' && /\b(first|1st) (basket|bucket|points? of)/.test(t) && !/\bpoints\b(?! of)/.test(t.replace(/(first|1st) points? of/, ''))) continue;
      if (WORDS[i][1] === 'pts' && (/\b(score|scorer)s? (a |an )?(td|touchdown)/.test(t) || /td|touchdown/.test(t))) continue;
      if (WORDS[i][1] === 'total' && /(first|1st)[\s-]*(half|quarter)|\b1h\b|\b1q\b/.test(t)) continue;
      s.markets.push(WORDS[i][1]);
    }
    // "sides", "game lines", "ATS": the game, not a player (spreads and moneylines; totals too for "game lines")
    if (/\bsides?\b|\bteams? to (win|cover)\b|\bteam bets?\b/.test(t) && !/\bboth sides\b/.test(t)) ['spread', 'ml'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    if (/\bgame lines?\b|\bmain lines?\b|\bgame bets?\b|\bstraight bets? on games\b/.test(t)) ['spread', 'ml', 'total'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    // "rushing yards over under" is the player's line, not the game total
    if (s.markets.indexOf('total') >= 0 && !/\b(game )?totals?\b/.test(t) && s.markets.some(function (m) { return /^(pts|reb|ast|rec|rec_yds|rush_yds|pass_yds|pass_td|pass_att|rush_rec_yds|pass_rush_yds)$/.test(m); })) s.markets.splice(s.markets.indexOf('total'), 1);
    // a position word only names a market when no stat was named ("wr receptions" is receptions)
    if (s.markets.indexOf('rec') >= 0 && s.markets.indexOf('rec_yds') >= 0 && !/receiving|\byards\b|\byds\b/.test(t)) s.markets.splice(s.markets.indexOf('rec_yds'), 1);
    if (s.markets.indexOf('first_td') >= 0 && /\bnba\b|basketball|bucket|basket|hoops/.test(t) && !/\btds?\b|touchdown/.test(t)) s.markets[s.markets.indexOf('first_td')] = 'first_basket';
    if (/\byards\b|\byds\b/.test(t) && !s.markets.some(function (m) { return /yds/.test(m); })) s.markets.push('rec_yds', 'rush_yds', 'pass_yds');
    if (/\bscore (the )?most\b|\bmost points\b|\btop (point )?scorers?\b|\bleading scorer\b|\bdrop (the )?most\b|\bhighest scor/.test(t)) { if (s.markets.indexOf('pts') < 0) s.markets.push('pts'); s.sort = 'proj'; s.side = 'over'; }
    if (/\bpra\b|pts ?\+ ?reb ?\+ ?ast/.test(t)) ['pts', 'reb', 'ast'].forEach(function (m) { if (s.markets.indexOf(m) < 0) s.markets.push(m); });
    // "favorites" / "dogs" with no market named: to win (moneyline); "favorite play / pick / prop" is a recommendation, not this
    var favW = /\bfavou?rites\b|\bfavs\b|\bchalk\b|\bfavou?rite\b(?!\s+(\w+\s+){0,2}(plays?|picks?|props?|bets?|sgps?|parlays?|tickets?|leans?|sides?|legs?))/.test(t) && !/\b(your|our|onyx'?s?|the model'?s?|my)( \w+){0,3} favou?rites?\b/.test(t);
    // "your top 10 favorite nfl overs" (11/8): what we recommend most, not the betting favorites
    if (/\b(your|our|onyx'?s?|the model'?s?)( \w+){0,3} favou?rites?\b|\b(your|our) (top|best)\b/.test(t) && s.sort === 'conf') s.sort = 'rec';
    var dogW = /\bunderdogs?\b|\bdogs\b/.test(t);
    var propsW = /\bprops?\b|\bplayer (bets?|lines?|markets?)\b/.test(t) && !/\bgame props?\b/.test(t);
    if ((favW || dogW) && !s.markets.length && !propsW) s.markets.push('ml');
    if (s.xmk) s.markets = s.markets.filter(function (m) { return s.xmk.indexOf(m) < 0; });   // never the market they ruled out
    if (favW && !dogW && s.markets.length === 1 && s.markets[0] === 'ml') s.max_price = s.max_price == null ? -101 : Math.min(s.max_price, -101);
    if (propsW) s.props_only = true;
    // "college" alone: football for a football market, basketball for a basketball one, else both
    if (genOnly) colSports(s).forEach(function (x) { if (s.sports.indexOf(x) < 0) s.sports.push(x); });
    // over / under
    // "over +150" alone is a price; "under -110 or better" is the under at a price rule
    var PR = '\\s*[+-]\\d+(?!\\d|\\s*(or|and)\\s*(better|shorter|longer|worse|more|less))';
    var ov = /\bovers?\b|\bhit the over\b|\bgo over\b|\bclear\b/.test(t.replace(new RegExp('\\bover' + PR, 'g'), '').replace(/over\/under/g, '')),
        un = /\bunders?\b|\bstay under\b|\bfade\b/.test(t.replace(new RegExp('\\bunder' + PR, 'g'), '').replace(/over\/under/g, ''));
    if (/over ?(\/|or|and|-)? ?under|o\/u/.test(t)) {
      // "game totals over unders overs": the market word, then the side
      var rest = t.replace(/\bover ?(\/|or|and|-)? ?unders?\b|\bo\/u\b/g, ' ');
      ov = /\bovers?\b|\bhit the over\b|\bgo over\b/.test(rest); un = /\bunders?\b|\bstay under\b/.test(rest);
      if (ov && un) { ov = false; un = false; }
    }
    if (ov && !un) s.side = 'over';
    if (un && !ov) s.side = 'under';
    // the whole ticket's price, said with total / ticket / parlay / combined (11/8, Jordan: "total odds of at least
    // +700"; "each leg minimum odds of -150 ... total odds of at least +700" lost the +700): read first and taken out,
    // so the per-leg prices around it read on their own
    var tot = t.match(/\b(?:total|ticket|parlay|combined|overall)\s+(?:odds|payout|price)?\s*(?:of\s+)?(?:at least|minimum|min|no less than|or more of)\s*(?:of\s*)?\+(\d{3,5})/)
      || t.match(/\b(?:total|ticket|combined|overall)\s+(?:odds|payout|price)\s+(?:of\s+)?\+(\d{3,5})/);
    if (tot) { s.target_price = +tot[1]; s.ticket_floor = true; if (s.intent === 'list') s.intent = 'parlay'; t = t.replace(tot[0], ' '); }
    // odds, in any wording. A floor: "-200 or better", "min -200", "nothing worse than -200",
    // "no -200 juice". A ceiling: "+300 or less", "max +300", "under +300".
    var fl = t.match(/(min(imum)?( total| parlay| ticket| combined)?( odds| payout| price)?( of)?|no (odds |price |leg )?(worse|shorter|juicier) than|nothing (worse|shorter|juicier) than|at least|odds of at least|better than|above)\s*([+-]?\d{3,4})/)
      || t.match(/([+-]\d{3,4})\s*(or better|or longer|and up|or more|minimum|min\b|floor)/) || t.match(/\bno\s*(-\d{3,4})\s*(juice|or worse)?/);
    if (fl) { var v = +(fl[fl.length - 1] && /\d/.test(fl[fl.length - 1]) ? fl[fl.length - 1] : (fl[1] || fl[fl.length - 1])); if (!isNaN(v)) s.min_price = v; }
    var fl2 = t.match(/([+-]\d{3,4})\s*(or better|or longer|and up|or more|minimum|floor)/); if (fl2) s.min_price = +fl2[1];
    var nojuice = t.match(/\bno\s*(-\d{3,4})/); if (nojuice) s.min_price = +nojuice[1] + 1;
    var btw = t.match(/between\s*([+-]?\d{3,4})\s*(and|to|-)\s*([+-]?\d{3,4})/);
    if (btw) { s.min_price = Math.min(+btw[1], +btw[3]); s.max_price = Math.max(+btw[1], +btw[3]); }
    var mx = btw ? null : t.match(/(max(imum)?( leg)?( odds| price)?( of)?|no more than|no (odds |price |leg |legs )?(longer|bigger|higher|better) than|nothing (longer|bigger|higher) than|(?:^|\s)shorter than|below|at most|or less than)\s*([+-]\d{3,4})/) || t.match(/([+-]\d{3,4})\s*(or less|or shorter|and shorter|or lower|max|cap)/);
    if (mx) { var w = +(mx[mx.length - 1] && /\d/.test(mx[mx.length - 1]) ? mx[mx.length - 1] : mx[1]); if (!isNaN(w)) s.max_price = w; }
    // a bare price on a parlay or a list ("4 leg NFL parlay -150", "odds -150"): each leg at that
    // price or shorter. It used to read as a floor, so +575 dogs filled a "-150" parlay.
    if (!fl && !mx && !btw && s.max_price == null && s.min_price == null && !s.target_price) {
      var bare = t.match(/(?:^|\s|odds\s*|at\s*)(-\d{3,4})(?!\d)/);
      if (bare) s.max_price = +bare[1];
    }
    // "3 leg same game parlay ... minimum odds +300" (11/6, Jordan): a plus-money minimum on a parlay is
    // the whole ticket's payout floor, not every leg's price. Each leg at +300 or longer only when the
    // request says so ("each leg", "every leg", "per leg") or asks for dogs / plus money / longshots.
    if (s.min_price != null && s.min_price >= 100 && !s.target_price && /\bparlay|\bsgp\b|same[\s-]?game|\blegs?\b|legger|\bticket/.test(t)
        && (/(\bmin(imum)?\b( total| parlay| ticket| combined)?( odds| payout| price)?( of)?|\bat least|odds of at least|pays at least)\s*\+\d{3,4}/.test(t)
            || s.min_price >= 400)      // "+2000 or longer" on a parlay is the ticket: no leg needs +2000 (11/6)
        && !(/\+\d{3,4}\s*(or better|or longer|and up|or more)/.test(t) && s.min_price < 400)
        && !/\b(each|every|per|all)\s+(leg|pick|play)s?\b|\blegs?\s+(each|at|of)\s+(at least\s+)?\+?\d/.test(t)
        && !/plus money|plus[\s-]odds|underdogs?|\bdogs\b|long ?shots?/.test(t)) {
      s.target_price = s.min_price; s.min_price = null; s.ticket_floor = true;
    }
    if (/plus money|plus[\s-]odds|\+ ?odds|underdogs?|\bdogs\b|long ?shots?|\bvalue dogs?\b/.test(t)) s.min_price = Math.max(s.min_price == null ? 100 : s.min_price, 100);
    if (/even money|around even|near even|pick ?em/.test(t)) { s.min_price = -125; s.max_price = 125; }
    if (favW && /\bml\b|money ?line|to win|\bwin\b/.test(t)) s.max_price = Math.min(s.max_price == null ? -101 : s.max_price, -101);
    // ordering
    if (/most likely|safest|safe\b|locks?\b|highest (chance|confidence|probability|hit rate)|sure ?thing|surest|can.?t lose|banker/.test(t)) s.sort = 'conf';
    if (/recommend|favou?rite (play|pick|bet|sgp|parlay|td|touchdown|scorer|prop|leg)|your (\d+ |top |four |three |five )?favou?rites?|my favou?rites?|best (picks?|plays?|bets?)|top picks?|your picks?|should i (bet|play)|what do you like|you like|pick of the (day|night)|play of the (day|night)|best bet/.test(t)) s.sort = 'rec';
    if (/\bvalue\b|most value|best value|biggest edge|\bedge\b|beats? (the )?(line|price|onyx|book)|mispriced|soft line|(^|\s)\+ ?ev\b|positive ev|\bev\b/.test(t)) s.sort = 'edge';
    if (/biggest payout|longshots?|long shots?|lottery|moonshot|highest odds|big payout/.test(t)) s.sort = 'price';
    if (/lock of the|pick of the|play of the|bet of the|prop of the|best bet\b|the lock\b|(highest|best|top|most likely|safest) (\w+ ){0,3}(prop|play|pick|bet|scorer)\b(?!s)/.test(t) && s.count == null && s.intent === 'list') s.count = 1;
    // confidence floor: "60%", "60 percent", "over 60%"
    var c = t.match(/(\d{2})\s*(%|percent)/); if (c) s.min_conf = +c[1] / 100;
    // time: tonight / today / tomorrow / a weekday / this weekend
    if (/tonight|today|this evening/.test(t)) s.when = 'today';
    else if (/tomorrow/.test(t)) s.when = 'tomorrow';
    else if (/this weekend|weekend/.test(t)) s.when = 'weekend';
    else for (var d = 0; d < 7; d++) if (new RegExp('\\b' + DAYS[d] + '\\b').test(t)) { s.when = DAYS[d]; break; }
    // the slate (11/8, Jordan: "1 PM slate only"): kickoff windows in ET hours, and a night of the week
    var SL = null;
    if (/\b(sunday night|snf)\b/.test(t)) SL = {h0: 19, h1: 28, dow: 0, label: 'Sunday night'};
    else if (/\b(monday night|mnf)\b/.test(t)) SL = {h0: 19, h1: 28, dow: 1, label: 'Monday night'};
    else if (/\b(thursday night|tnf)\b/.test(t)) SL = {h0: 19, h1: 28, dow: 4, label: 'Thursday night'};
    else if (/\b(prime ?time|night games?|late night)\b/.test(t)) SL = {h0: 19, h1: 28, label: 'night games'};
    else if (/\bearly (games?|slate|window|kickoffs?|ones)\b|\b1 ?(pm|p m|oclock)\b|\b1:00\b/.test(t)) SL = {h0: 12, h1: 15, label: '1 PM slate'};
    else if (/\blate (games?|slate|window|afternoon|kickoffs?|ones)\b|\b4 ?(pm|p m|oclock)\b|\b4:(05|25)\b/.test(t)) SL = {h0: 15, h1: 18.5, label: '4 PM slate'};
    else {
      var hm = t.match(/\b(\d{1,2})(?::(\d{2}))? ?(pm|am)\b/);
      if (hm && /slate|games?|kick|tip|start|only|window|game/.test(t)) {
        var hh = (+hm[1] % 12) + (hm[3] === 'pm' ? 12 : 0) + (hm[2] ? +hm[2] / 60 : 0);
        SL = {h0: hh - 0.25, h1: hh + 0.5, label: hm[1] + (hm[2] ? ':' + hm[2] : '') + ' ' + hm[3].toUpperCase() + ' games'};
      }
    }
    if (SL) s.slot = SL;
    if (SL && /\b(snf|mnf|tnf|(sunday|monday|thursday) night football)\b/.test(t)) s.sports = ['nfl'];   // SNF is the NFL, never college
    // the teams it names: every college and pro team (readTeams), then a conference ("SEC spreads")
    var RT = readTeams(cfx ? ' ' + cnorm(t).replace(/-/g, ' ').replace(new RegExp(cfx.re.source, 'g'), ' ') + ' ' : t, s, B, colSig), tPlayer = RT.tPlayer;
    if (RT.ambig) s.ambig = RT.ambig;
    if (RT.teams.length) {
      if (RT.teams.length === 1) s.team = RT.teams[0]; else { s.teams = RT.teams; s.team = null; }
      s.tabbr = RT.tab; if (RT.school) s.school = RT.school;
      if (RT.names.length && !RT.school) s.team_name = RT.names.join(', ');
      var keep = s.sports.filter(function (x) { return RT.sports.indexOf(x) >= 0; });
      s.sports = !s.sports.length || genOnly || !keep.length ? RT.sports.slice() : keep;
    }
    if (RT.colAlt.length && !RT.ambig) s.col_alt = RT.colAlt.map(function (c) { return schoolPatch(c, colSports({markets: s.markets, sports: []}), B); });
    if (cfx && !s.team && !(s.teams || []).length && !s.ambig) {
      var csp = colSports(s).filter(function (x) { return cfx.sports.indexOf(x) >= 0; });
      if (!csp.length) csp = cfx.sports.slice();
      s.conf = cfx.name; s.tabbr = {}; csp.forEach(function (x) { s.tabbr[x] = cfx.tabbr[x]; });
      s.sports = csp;
    } else if (!cfx && CONF_NO.test(' ' + cnorm(t).replace(/-/g, ' ') + ' ') && !s.team) s.unsupported = 'that conference by name|we have the SEC, Big Ten, Big 12, ACC, Big East, Pac-12, Mountain West, WCC, A-10, American, MAC, Sun Belt, C-USA, Ivy and Missouri Valley, or name a team';
    if (!s.team && !(s.teams || []).length && !s.ambig && !s.conf) {
      // abbreviations only when typed in capitals ("MIN -200" is odds, "MIN" is Minnesota)
      var EXTOK = {}; EXW.forEach(function (w) { String(w).toUpperCase().split(/\s+/).forEach(function (x) { EXTOK[x] = 1; }); });
      var qX = String(q).replace(/\b[A-Z][A-Z&-]{1,4}\b/g, function (m) { return EXTOK[m] ? ' ' : m; });   // "except UNLV": not the team asked for (11/6)
      var tm = qX.match(/\b(ATL|BOS|BKN|CHA|CHI|CLE|DAL|DEN|DET|GS|GSW|HOU|IND|LAC|LAL|MEM|MIA|MIL|MIN|NOP|NYK|OKC|ORL|PHI|PHX|POR|SAC|SAS|TOR|UTAH|UTA|WSH|WAS|ARI|BAL|BUF|CAR|CIN|GB|JAX|KC|LV|LAR|NE|NYG|NYJ|PIT|SEA|SF|TB|TEN|VGK|EDM|COL|NYR|NYI|NJ|CBJ|WPG|VAN|CGY|OTT|MTL|NSH|STL|SJ|ANA)\b/);
      if (tm) s.team = ({GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH'})[tm[1]] || tm[1];
      // a school's abbreviation in capitals ("DUKE", "UK", "GONZ")
      if (!tm) {
        teamDir();
        var cm = /[a-z]/.test(String(q)) ? qX.match(/\b[A-Z][A-Z&-]{1,4}\b/g) || [] : [];   // not in an all-caps request
        for (var cj = 0; cj < cm.length; cj++) {
          var cc = COLS.byAb[cm[cj]] || COLS.filter(function (x) { return x.cfb === cm[cj]; })[0];
          if (cc && (cm[cj].length >= 3 || cm[cj] === 'UK') && !/^(SGP|ATS|PRA|NBA|NFL|NHL|CFB|CBB|TDS|MVP|ROTY|OVER|PLUS)$/.test(cm[cj])) {
            var pt2 = schoolPatch(cc, colSports(s), B); s.team = pt2.team; s.tabbr = pt2.tabbr; s.school = pt2.school; s.sports = pt2.sports;
            break;
          }
        }
      }
    }
    // a player: a nickname, a full name, a last or first name (the most prominent one), or one letter off
    // only players of the sport the named market belongs to ("receiving yards" is never an NBA player)
    var PC = names(B, PRIOR), FOOT = /^(rec|rec_yds|rush_yds|pass_yds|pass_td|pass_att|anytime_td|first_td|two_plus_td|three_td|rush_rec_yds|pass_rush_yds)$/, HOOP = /^(pts|reb|ast|threes|first_basket)$/;
    var mk = s.markets || [], want = mk.length && mk.every(function (m) { return FOOT.test(m); }) ? ['nfl', 'cfb'] : mk.length && mk.every(function (m) { return HOOP.test(m); }) ? ['nba', 'cbb'] : null;
    if (want) Object.keys(PC).forEach(function (k) { var sp = Object.keys(PC[k].sp || {}); if (sp.length && !sp.some(function (x) { return want.indexOf(x) >= 0; })) delete PC[k]; });
    s.player = findPlayer(tPlayer, PC, s.markets);
    // a rostered player with no line today, typed by his full name ("jeremiah smith receiving yards")
    var rost = null;
    if (!s.player) {
      Object.keys(ROSTER).forEach(function (k) {
        if (tPlayer.indexOf(' ' + k + ' ') >= 0 && (!want || want.indexOf(ROSTER[k].sp) >= 0) && (!rost || k.length > rost.k.length)) rost = {k: k, r: ROSTER[k]};
      });
      if (rost) s.player = rost.r.name;
    }
    if (s.player) {
      s.team = null; if (s.intent === 'list' && s.count == null && !/props|plays|lines|bets/.test(t)) s.count = 5;
      if (!s.sports.length) {
        var pl = String(s.player).toLowerCase(), on2 = sportsOn(B, function (p) { return p.kind === 'prop' && String(p.name || '').toLowerCase() === pl; });
        if (on2.length) s.sports = on2;
        else if ((PRIOR || []).some(function (r) { return String(r.n).toLowerCase() === pl; })) s.sports = ['nba'];
        else if (/mcdavid|ovechkin|mackinnon|matthews|draisaitl|kucherov|makar|crosby/.test(pl)) s.sports = ['nhl'];
        else if (/alcaraz|sinner|djokovic|sabalenka|swiatek|gauff/.test(pl)) s.sports = ['tennis'];
        else if (/^(jeremiah smith|arch manning|julian sayin|ryan williams)$/.test(pl)) s.sports = ['cfb'];
        else if (NFLSTAR.test(pl)) s.sports = ['nfl'];
        else if (rost) s.sports = [rost.r.sp];
      }
    }
    // defaults that follow from the rest
    if (s.markets.indexOf('two_plus_td') >= 0) { s.sort = 'two_td'; if (!s.sports.length) s.sports = ['nfl']; }
    if (s.markets.indexOf('three_td') >= 0 && !s.sports.length) s.sports = ['nfl'];
    if (s.markets.indexOf('anytime_td') >= 0 && !s.sports.length) s.sports = ['nfl', 'cfb'];
    if (s.markets.some(function (m) { return /^(pts|reb|ast|q1_total)$/.test(m); }) && !s.sports.length) s.sports = ['nba'];
    if (s.markets.some(function (m) { return /^(rec|rec_yds|rush_yds|pass_yds|pass_td|pass_att|rush_rec_yds|pass_rush_yds)$/.test(m); }) && !s.sports.length) s.sports = ['nfl'];
    if (s.intent === 'rr' && s.count == null) s.count = 4;
    // a matchup in abbreviations: "KC @ DEN", "lal vs bos"
    var AB = {GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH'};
    var ABS = /^(ATL|BOS|BKN|CHA|CHI|CLE|DAL|DEN|DET|GS|GSW|HOU|IND|LAC|LAL|MEM|MIA|MIL|MIN|NOP|NYK|NY|OKC|ORL|PHI|PHX|POR|SAC|SAS|SA|TOR|UTAH|UTA|WSH|WAS|ARI|BAL|BUF|CAR|CIN|GB|JAX|KC|LV|LAR|NE|NYG|NYJ|PIT|SEA|SF|TB|TEN|VGK|EDM|COL|NYR|NYI|NJ|CBJ|WPG|VAN|CGY|OTT|MTL|NSH|STL|SJ|ANA)$/;
    var mu = null, mre = /\b([A-Za-z]{2,4})(?:\s*@\s*|\s+(?:vs\.?|v\.?|versus|at)\s+)([A-Za-z]{2,4})\b/gi, mm0;
    while ((mm0 = mre.exec(String(q))) && !mu) {
      if (ABS.test(mm0[1].toUpperCase()) && ABS.test(mm0[2].toUpperCase()) && mm0[1].toUpperCase() !== mm0[2].toUpperCase()
          && !/^(no|at|was|vs)$/i.test(mm0[1]) && !/^(no|at|was|vs)$/i.test(mm0[2])) mu = mm0;
    }
    if (mu) {
      var ta = AB[mu[1].toUpperCase()] || mu[1].toUpperCase(), tb = AB[mu[2].toUpperCase()] || mu[2].toUpperCase();
      s.teams = [ta, tb]; s.team = null;
      if (!s.sports.length) { var both = sportsOn(B, function (p) { return onTeams(p, [ta]); }).filter(function (x) { return sportsOn(B, function (p) { return onTeams(p, [tb]); }).indexOf(x) >= 0; }); if (both.length === 1) s.sports = both; }
    }
    // the players and teams they do not want
    if (EXW.length) {
      s.exclude = [];
      var NMx = typeof PC !== 'undefined' ? PC : names(B, PRIOR);
      EXW.forEach(function (ph) {
        // a player's exact full name first ("but not Marshall Pritchett" is the player, not Marshall the school)
        var phc = clean(ph.replace(/\b(rn|pls|please|thx|today|tonight|asap)\b/g, ' ').replace(/\s+/g, ' ').trim());
        if (phc && NMx[phc]) { s.exclude.push(typeof NMx[phc] === 'string' ? NMx[phc] : ph); return; }
        // a team by its name: the school (each sport's abbreviation) or the pro team
        teamDir(); var ce = NKEY[cnorm(ph).replace(/-/g, ' ')] || NKEY[cnorm(ph).replace(/-/g, ' ').replace(/^the /, '')];
        if (ce && ce.col.length && (colSig || !ce.pro.length) && !NICK[cnorm(ph)]) {
          var best = Math.min.apply(null, ce.col.map(function (e) { return RANK[e.kind]; })), cs = ce.col.filter(function (e) { return RANK[e.kind] === best; });
          if (cs.length === 1) { s.exclude.push(cs[0].c.cbb); if (cs[0].c.cfb && cs[0].c.cfb !== cs[0].c.cbb) s.exclude.push(cs[0].c.cfb); return; }
        }
        // a nickname two pro teams share ("Kings"): the one in the sport asked about (11/8: "nhl parlay without Kings" left out Sacramento)
        if (ce && ce.pro.length > 1 && (s.sports || []).length) { var inSp = ce.pro.filter(function (e) { return s.sports.indexOf(e.p.sport) >= 0; }); if (inSp.length === 1) { s.exclude.push(inSp[0].p.abbr); return; } }
        if (ce && ce.pro.length === 1 && !(colSig && ce.col.length)) { s.exclude.push(ce.pro[0].p.abbr); return; }
        var nkHit = Object.keys(NICK).sort(function (a, b) { return b.length - a.length; }).filter(function (k) { return new RegExp('(^|\\s)' + esc(k) + '(\\s|$)').test(ph); })[0];
        if (nkHit) {
          // the team of that nickname in the sport asked about ("nhl ... without Kings" is LA, not Sacramento)
          var spN = (s.sports || []).length ? PROS.filter(function (pp) { return s.sports.indexOf(pp.sport) >= 0 && cnorm(pp.mascot) === nkHit; }) : [];
          s.exclude.push(spN.length === 1 ? spN[0].abbr : NICK[nkHit]); return;
        }
        var ph2 = ph.split(' ').filter(function (w) { return !NOT_NAMES.test(w); }).join(' ');
        if (!ph2) return;
        var pl = findPlayer(' ' + ph2 + ' ', NMx, s.markets);
        // a near match only when the last name agrees ("Chance Williams" is never Joseph Williams, 11/6)
        var lastW = function (x) { var w = clean(String(x || '')).replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').trim().split(' '); return w[w.length - 1]; };
        if (pl && lastW(pl) !== lastW(ph2)) pl = null;
        if (pl && ph2.split(' ').length >= 2 && clean(pl).split(' ')[0].charAt(0) !== clean(ph2).split(' ')[0].charAt(0)) pl = null;
        s.exclude.push(pl || ph2);
      });
      if (!s.exclude.length) delete s.exclude;
      else if (s.player && s.exclude.indexOf(s.player) >= 0) s.player = null;
    }
    // what Onyx does not price, or search does not cover: say so and offer what we do (11/2: these
    // came back as a random top 5)
    var UNS = [
      [/\bteasers?\b/, 'teasers'],
      [/\bfutures?\b|\bwins? the (super ?bowl|title|championship|finals|stanley cup|world series|heisman|national title)\b|\bto win the (super ?bowl|title|championship|finals|stanley cup|cup|division|conference|national title|heisman|world series)\b|\b(super ?bowl|championship|title) odds\b|\bmvp\b|\broty\b|\brookie of the year\b|\bheisman\b|\bdpoy\b|\bcoach of the year\b|\bwin totals?\b|\bseason (wins?|win total)\b|\bplayoff odds\b|\bmake the playoffs\b/, 'futures and season-long bets'],
      [/\bgolf\b|\bpga\b|\blpga\b|\bmasters\b|\btop (5|10|20) finish\b|\bmake the cut\b|\bbirdies\b/, 'golf|our golf leans are on the Golf page'],
      [/\bmlb\b|\bbaseball\b|\bhome ?runs?\b|\bhomers?\b|\bstrike ?outs?\b|\bpitchers?\b|\bworld series\b/, 'MLB|the 2026 season is over, and its record is on the MLB page'],
      [/\bshots? on goal\b|\bsog\b|\bgoal ?scorers?\b|\banytime goal\b|\bto score a goal\b|\bsaves\b|\bgoalies?\b/, 'NHL goal scorers, shots and saves|we have NHL player points and assists when Onyx prices them'],
      [/\bthrees\b|\b3[\s-]?pointers?\b|\bthree[\s-]?pointers?\b|\b3pm\b|\bmade threes\b|\b3s made\b/, 'threes|each player\'s bet card on the NBA page has them'],
      [/\bdouble[\s-]?doubles?\b|\btriple[\s-]?doubles?\b/, 'double-doubles and triple-doubles|the NBA bet cards have them'],
      [/\bpra\b|\bp ?\+ ?r ?\+ ?a\b|\bpts ?\+ ?reb|\bpts ?\+ ?ast|\breb ?\+ ?ast|\bp ?\+ ?r\b|\bp ?\+ ?a\b|\br ?\+ ?a\b|\b(points|pts|rebounds|reb|boards|assists|ast|dimes) (\+|plus|&) (points|pts|rebounds|reb|boards|assists|ast|dimes)\b|\b(points|rebounds|assists|boards|dimes) (and|\+) (points|rebounds|assists|boards|dimes) combos?\b/, 'combined-stat props|each player\'s bet card on the NBA page has PRA, P+R and P+A'],
      [/\bteam totals?\b/, 'team totals'],
      [/\b(1st|first|2nd|second|3rd|third|4th|fourth)[\s-]*(quarter|half|period|q)\b(?:\s+\w+){0,2}\s+(spreads?|money ?lines?|ml|to win|winners?)\b|\b(q[1-4]|[1-4]q|1h|2h|h1|h2)\s*(spreads?|ml|money ?lines?)\b|\b(spreads?|money ?lines?|ml)\s+(for|in) the (1st|first|2nd|second) (half|quarter)\b/, 'quarter and half spreads or moneylines|we have NBA 1st-quarter and 1st-half totals'],
      [/\b(2nd|second|3rd|third|4th|fourth)[\s-]*(quarter|half|period)\b|\b(q[2-4]|[2-4]q|2h|h2)\b/, 'later quarters and the 2nd half|we have NBA 1st-quarter and 1st-half totals'],
      [/\bhedge|\bcash ?out\b|\bcashing out\b/, 'hedging and cash outs'],
      [/\bcorrect score\b|\bexact score\b|\bset betting\b|\bwinning margin\b|\brace to \d/, 'exact-score and set bets'],
      [/\bboosts?\b|\bpromos?\b|\bodds boost\b|\bbonus\b|\bparlay insurance\b|\bfree bets?\b|\bprofit boost\b/, 'promos and boosts|the Onyx app has them'],
      [/\bsoccer\b|\bpremier league\b|\bepl\b|\bmls\b|\bchampions league\b|\bufc\b|\bmma\b|\bboxing\b|\bf1\b|\bformula 1\b|\bnascar\b|\bcricket\b|\bwnba\b|\besports\b|\bdarts\b/, 'that sport']
    ];
    // the NCAA tournament out of season (11/2): say when it is, and offer today's college games
    var mon = new Date().getMonth();
    if (mon !== 2 && !(mon === 3 && new Date().getDate() <= 8)) UNS.splice(2, 0, [/\bmarch madness\b|\bncaa tournament\b|\bbig dance\b|\bfinal four\b|\bsweet (16|sixteen)\b|\belite (8|eight)\b|\bbrackets?\b|\bbracketology\b|\bselection sunday\b|\bconference tournaments?\b/,
      'NCAA tournament bets|the tournament starts in March; today\'s college basketball games are on the board']);
    for (var ui = 0; ui < UNS.length && !s.unsupported; ui++) if (UNS[ui][0].test(t)) { s.unsupported = UNS[ui][1]; break; }
    // college basketball markets Onyx does not price on our board (props, halves): say so, never empty
    var cbbOnly = s.sports.length === 1 && s.sports[0] === 'cbb';
    if (cbbOnly && !s.unsupported && (s.props_only || s.player || s.markets.some(function (m) { return !/^(spread|total|ml)$/.test(m); }))
        && !(B || []).some(function (p) { return p.sport === 'cbb' && (s.markets.length ? s.markets.indexOf(p.mkt) >= 0 : p.kind === 'prop'); })) {
      s.unsupported = s.props_only || s.markets.some(function (m) { return /^(pts|reb|ast|threes|first_basket)$/.test(m); }) || s.player
        ? 'college basketball player props|Onyx posts a few, but our player projections have not been tested against its prices yet. Projected minutes, points, rebounds and assists are on the College Basketball players page'
        : 'that college basketball market|today\'s college basketball board has spreads, totals and moneylines';
    }
    if (/(rebound|assist|catch|rush|pass|score)s? the most|most (receptions|catches|rushing|passing|receiving|yards|rebounds|assists|boards|dimes)|leading (rusher|receiver|passer|rebounder|scorer)s?|top( \d+)? (rusher|receiver|passer|rebounder|scorer|qb|wr|rb)s?/.test(t) && s.sort !== 'edge' && s.sort !== 'rec') { s.sort = 'proj'; if (s.side === 'any') s.side = 'over'; }
    // "top 5 passing yard projections" (11/8): the biggest projections, ranked by projection
    if (/\bprojections?\b|\bprojected\b/.test(t) && s.sort === 'conf' && s.markets.length) s.sort = 'proj';
    if (s.markets.indexOf('first_td') >= 0 && !s.sports.length) s.sports = ['nfl'];
    if ((s.markets.indexOf('first_basket') >= 0 || s.markets.indexOf('h1_total') >= 0) && !s.sports.length) s.sports = ['nba'];
    if (s.count == null && /\bcouple\b/.test(t)) s.count = 2;
    if (s.count == null && /\b(a )?few\b/.test(t)) s.count = 3;
    if (s.count == null) s.count = s.intent !== 'list' ? 3 : /\b(the|a|one) (player|play|pick|bet|guy|team)\b|\bwho (is|will|gets|has)\b|\bmost likely\b/.test(t) && !/players|plays|picks|guys|teams|scorers|receivers|rushers|passers|options|bets|choices/.test(t) ? 1 : 5;
    if (!RT.teams.length && !s.player && /(^|[^A-Za-z])Wild\b(?!\s*card)|\bthe wild\b(?!\s*card)|\bmn wild\b/.test(RAWQ) && (B || []).some(function (p) { return p.sport === 'nhl' && /\bMIN\b/.test(p.matchup || ''); })) {
      s.team = 'MIN'; s.tabbr = {nhl: ['MIN']}; s.sports = ['nhl']; s.team_name = 'Minnesota Wild';
    }
    // a game by its two abbreviations as the boards print them ("LV vs SF spread", "SJ MIN totals",
    // "copp @ gmu moneyline"; 11/6, 98 misses in the 100k test): both teams of one game on the boards
    // (11/8: a game that started still names its teams, so the answer can say it started; and two board
    // abbreviations beat a player found from one of them as a first name: "VAN @ EDM" is not Van Jefferson)
    var fullP = s.player && clean(t).indexOf(clean(s.player)) >= 0;
    if (RT.teams.length <= 2 && !fullP) {
      var tok = {}; t.replace(/[^a-z0-9&\- ]/g, ' ').split(/\s+/).forEach(function (w) { if (w) tok[w] = 1; });
      var hitG = {}, nowT = Date.now();
      (B || []).forEach(function (p) {
        if (Date.parse(p.start) <= nowT - 8 * 3600e3 || !p.matchup) return;
        var m = String(p.matchup).split(/\s+(?:@|vs)\s+/);
        if (m.length === 2 && tok[m[0].toLowerCase()] && tok[m[1].toLowerCase()]) hitG[p.sport + '|' + [m[0], m[1]].sort().join('|')] = [p.sport, m[0], m[1]];
      });
      var HG = Object.keys(hitG);
      if (HG.length === 1) {
        var hg = hitG[HG[0]]; s.player = null; s.teams = [hg[1], hg[2]]; s.team = null; s.school = null; s.team_name = null; s.ambig = null; s.tabbr = {}; s.tabbr[hg[0]] = [hg[1], hg[2]]; s.sports = [hg[0]];
        if (s.intent === 'list') s.one_per_game = false;
      }
    }
    // Onyx Picks (11/2): "Onyx picks", "official picks", "tracked picks": only the logged picks,
    // never a projection called a pick
    if (/\bonyx(s)? (official )?picks?\b|\bofficial (onyx )?picks?\b|\btracked picks?\b|\bgraded picks?\b|\bpicks page\b|\bonyx pick of the (day|night)\b/.test(t)) { s.onyx_picks = true; if (s.sort === 'conf') s.sort = 'rec'; }
    // depth charts, minutes, starters and pace (11/2): answered from data/<sport>/depth.json, not the board
    var DEP = /\bwho (starts|is starting|s starting|will start|are the starters)\b|\bstarting (five|5|lineup|lineups|qb|quarterback|goalie|g)\b|\bstarters?\b|\bdepth( charts?)?\b|\brotations?\b|\b(projected |expected )?(minutes|mins)\b|\bplaying time\b|\bpace\b|\btempo\b|\busage\b|\bsnap (counts?|shares?)\b|\bice time\b|\blineups?\b|\bwho plays (for|on)\b|\bprojected (stats|numbers|line)\b|\bprojections? for\b/;
    if (DEP.test(t) && s.intent === 'list' && !s.unsupported && s.min_price == null && s.max_price == null && !s.target_price && !/\b(parlay|sgp|legs?|odds|bet|bets|spread|moneyline|ml|over|under|overs|unders)\b/.test(t)) {
      s.depth = {what: /pace|tempo/.test(t) ? 'pace' : /start|lineup|five\b/.test(t) ? 'start' : /minutes|mins|playing time|ice time|snap|usage/.test(t) ? 'min' : 'chart', text: cnorm(tPlayer.replace(/_+/g, ' ')),
        foot: /\b(qb|qbs|quarterbacks?|snaps?|receivers?|running backs?|wrs?|rbs?|tes?|tight ends?|football|offense|defense|plays per game)\b/.test(t)};
    }
    return s;
  }

  // ── the spec, run against today's boards ────────────────────────────────
  // who a play is about: a player, or for a game line the game and the market (every game total
  // is named "Total", so keying on the name alone kept one total across the whole board)
  // (a 1st-quarter or 1st-half total is a prop row whose "who" is the market, not a player: key it by game, 11/2)
  function WHO(p) { return p.kind === 'prop' && !/_total$/.test(p.mkt || '') ? p.sport + ':' + p.who : p.sport + ':' + p.gid + ':' + (p.kind === 'spread' || p.kind === 'ml' ? 'side' : p.kind === 'prop' ? p.mkt : p.kind); }
  function p2(lam) { return lam == null ? null : 1 - Math.exp(-lam) * (1 + lam); }
  function dec(o) { return o > 0 ? 1 + o / 100 : 1 + 100 / -o; }
  function am(d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  // the ET calendar day of a start time vs "today" / "tomorrow" / a weekday / the weekend
  // ET wall-clock date for a timestamp; cached, since toLocaleString is slow and every play shares a few start times
  var ETC = {};
  function etDay(t) { var k = typeof t === 'number' ? Math.floor(t / 60000) : t; return ETC[k] || (ETC[k] = new Date(new Date(t).toLocaleString('en-US', {timeZone: 'America/New_York'}))); }
  function whenOk(when, start) {
    var t = Date.parse(start); if (isNaN(t)) return true;
    var g = etDay(t), now = etDay(Date.now() - 4 * 3600e3);   // the site's day rolls at 4 AM ET
    var days = Math.round((new Date(g.getFullYear(), g.getMonth(), g.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    if (g.getHours() < 4) days -= 1;                            // a 1 AM tip belongs to the night before
    if (when === 'today') return days <= 0;
    if (when === 'tomorrow') return days === 1;
    if (when === 'weekend') return g.getDay() === 0 || g.getDay() === 6;
    var wd = DAYS.indexOf(when); return wd < 0 || (g.getDay() === wd && days < 7);
  }
  // a kickoff window in ET hours (a 1 AM start counts as 25, the night before), and a night of the week
  function slotOk(sl, start) {
    var t = Date.parse(start); if (isNaN(t) || !sl) return true;
    var g = etDay(t), h = g.getHours() + g.getMinutes() / 60, dow = g.getDay();
    if (h < 4) { h += 24; dow = (dow + 6) % 7; }
    return h >= sl.h0 && h < sl.h1 && (sl.dow == null || dow === sl.dow);
  }
  function run(spec, B) {
    var now = Date.now();
    // "2 legs paying +300": each leg has to carry its share of the payout
    if ((spec.intent === 'parlay' || spec.intent === 'sgp') && spec.target_price && spec.count_set && spec.count >= 1 && !spec.no_leg_floor) {
      var per = Math.pow(1 + spec.target_price / 100, 1 / spec.count);
      var floor = am(spec.ticket_floor ? per : per * 0.97);    // "+750 or more": every leg carries its full share (11/6: 3 legs at 0.97 each paid +690)
      if (spec.min_price == null || spec.default_floor || spec.min_price < floor) spec = Object.assign({}, spec, {min_price: floor});
    }
    var mk = (spec.markets || []).slice();
    var two = mk.indexOf('two_plus_td') >= 0 || spec.sort === 'two_td';
    // 2+ touchdowns at Onyx's own price (11/8: "3 leg 2+ TD parlay, +1000 or more" came back +122, built
    // from anytime prices): Onyx prices 2+ TDs (over 1.5 touchdowns), so the board's two_td rows are the
    // legs, their prices make the ticket and the payout floors apply. The anytime rows priced off the TD
    // model remain only for a board with no 2+ prices (college football)
    var twoOnyx = two && B.some(function (p) { return p.mkt === 'two_td' && (!spec.sports || !spec.sports.length || spec.sports.indexOf(p.sport) >= 0); });
    if (twoOnyx) { mk = mk.filter(function (m) { return m !== 'two_plus_td' && m !== 'anytime_td'; }); mk.push('two_td'); two = false; }
    if (two && mk.indexOf('anytime_td') < 0) mk.push('anytime_td');
    var TL = teamList(spec);
    var pool = B.filter(function (p) {
      var t = Date.parse(p.start); if (!isNaN(t) && t <= now) return false;
      if (spec.sports && spec.sports.length && spec.sports.indexOf(p.sport) < 0) return false;
      if (mk.length && mk.indexOf(p.mkt) < 0 && mk.indexOf(p.kind) < 0) return false;
      if (spec.props_only && p.kind !== 'prop') return false;
      if (spec.no_props && p.kind === 'prop') return false;                                  // "no props": game lines only
      if (spec.xmk && (spec.xmk.indexOf(p.mkt) >= 0 || spec.xmk.indexOf(p.kind) >= 0)) return false;   // "no first basket" (11/6)
      if (spec.side && spec.side !== 'any' && (p.kind === 'prop' || p.kind === 'total') && p.side !== spec.side) return false;
      // 2+ touchdowns: priced off the TD model (lam), so the anytime price and its floors do not apply;
      // the player, team, day and exclusions still do (11/2: "two touchdowns for kelce" answered with
      // the whole board)
      if (two && p.lam == null) return false;
      if (!two && spec.min_price != null && p.price < spec.min_price) return false;
      if (!two && spec.max_price != null && p.price > spec.max_price) return false;
      if (!two && spec.min_conf != null && p.conf < spec.min_conf) return false;
      if (!two && spec.min_edge != null && p.edge < spec.min_edge) return false;
      if (spec.player && String(p.name || p.label).toLowerCase().indexOf(String(spec.player).toLowerCase()) < 0) return false;
      if (spec.exclude && spec.exclude.length && spec.exclude.some(function (x) {
        x = String(x || '').trim();
        if (/^[A-Z0-9&-]{2,5}$/.test(x)) { var tmx = p.team || (p.kind === 'spread' || p.kind === 'ml' ? p.name : '');   // a team: its players and its side
          return tmx ? String(tmx).toUpperCase() === x : new RegExp('(^|[^A-Z])' + x.replace(/[&-]/g, '\\$&') + '([^A-Z]|$)').test(String(p.matchup || '').toUpperCase()); }
        x = clean(x); return x && clean(String(p.name || '') + ' ' + String(p.label || '')).indexOf(x) >= 0; })) return false;   // "Ja'Marr" = "jamarr" (11/6)
      // the teams named, per sport (a college abbreviation means nothing on a pro board: "DEN" is the
      // Denver Pioneers in college basketball and the Nuggets in the NBA)
      var TLp = teamsFor(spec, p.sport, TL);
      if (spec.tabbr && !TLp.length) return false;
      if (TLp.length && !onTeams(p, TLp)) return false;
      if (TLp.length && (p.kind === 'spread' || p.kind === 'ml') && TLp.indexOf(String(p.team || p.name).toUpperCase()) < 0) return false;   // "Georgia to cover" is Georgia's side
      // "Celtics points overs": Celtics players, not the Hornets in the same game (11/6: Coby White came back);
      // a same-game parlay keeps the whole game
      if (TLp.length && p.kind === 'prop' && p.team && spec.intent !== 'sgp' && TLp.indexOf(String(p.team).toUpperCase()) < 0) return false;
      if (spec.onyx_picks && !p.pick) return false;
      if (spec.when && !whenOk(spec.when, p.start)) return false;
      if (spec.slot && !slotOk(spec.slot, p.start)) return false;
      return true;
    }).map(function (p) { return two ? Object.assign({}, p, {two: p2(p.lam)}) : p; });
    // "cbb unders", "overs tonight": the totals and player lines, when there are any (not sides)
    if (spec.side && spec.side !== 'any' && !mk.length && pool.some(function (p) { return p.kind === 'prop' || p.kind === 'total'; }))
      pool = pool.filter(function (p) { return p.kind === 'prop' || p.kind === 'total'; });
    // "recommended": what this site stands behind first (graded picks, then the
    // on-trial lanes), then the blend of confidence and value
    var REC = {tracked: 0.2, trial: 0.1};
    var key = twoOnyx ? function (p) { return -p.conf; } : spec.sort === 'two_td' || two ? function (p) { return -p.two; } : spec.sort === 'edge' ? function (p) { return -p.edge; }
      : spec.sort === 'price' ? function (p) { return -p.price; }
      : spec.sort === 'proj' ? function (p) { return -(p.proj || 0); }
      : spec.sort === 'rec' ? function (p) {
          // touchdown scorers: every price carries the margin, so the edge shown is always negative;
          // the favorites are the ones our TD model rates highest against their price
          if (p.model != null && /td$/.test(p.mkt || '')) return -((REC[p.tag] || 0) + 0.25 * p.conf + Math.max(-0.05, Math.min(0.12, p.model - p.conf)));   // mostly the model's lean against the price, capped (a 25-point gap is usually news the model missed), a little likelihood
          return -((p.pick ? 1 : 0) + (REC[p.tag] || 0) + p.conf + 2 * Math.max(-0.05, p.edge)); }   // a logged Onyx Pick first
      : function (p) { return -p.conf - p.edge / 10; };
    pool.sort(function (a, b) { return key(a) - key(b); });
    // "best value" when nothing in the pool beats Onyx's price (touchdown scorers: none did in
    // testing): ranking by the least-negative edge would just surface longshots, so show the
    // most likely instead and say so
    var note = '';
    var tdOnly = mk.length && mk.every(function (m) { return /td$/.test(m); });
    if (spec.sort === 'edge' && !two && pool.length && pool[0].edge <= 0 && tdOnly && pool.some(function (p) { return p.model != null; })) {
      // touchdown "best value": the chance shown is Onyx's price less its margin, so the shown edge is
      // the same for every player at a price; rank by how much our TD model likes them against it
      key = function (p) { return -(0.25 * p.conf + Math.max(-0.05, Math.min(0.12, (p.model != null ? p.model : p.conf) - p.conf))); };
      pool.sort(function (a, b) { return key(a) - key(b); });
      spec.td_fav = true;
    } else if (spec.sort === 'edge' && !two && pool.length && pool[0].edge <= 0) {
      key = function (p) { return -p.conf - p.edge / 10; };
      pool.sort(function (a, b) { return key(a) - key(b); });
      note = (mk.length && mk.every(function (m) { return /td$/.test(m); }) ? 'No touchdown scorer beats Onyx\'s price in our testing' : 'Nothing that matches beats Onyx\'s price right now')
        + ', so these are the most likely instead.';
    }
    if (spec.intent === 'sgp') return sgp(spec, pool, key);
    var n = Math.max(1, Math.min(spec.intent === 'list' ? 25 : 8, spec.count || 5));
    if (spec.intent === 'parlay' && spec.target_price && !spec.count_set) n = 10;   // no leg count asked: add legs until the payout is reached
    var picked = [], games = {}, who = {}, mkts = {};
    // a parlay of distinct ideas: one leg per market first (unless the request names one market),
    // so a ticket is not one read three times; a second pass fills if the board is thin
    var mcap = (spec.intent === 'parlay' || spec.intent === 'rr') && (spec.markets || []).length !== 1 ? 1 : 99;
    for (var pass = 0; pass < 2 && picked.length < n; pass++) {
    for (var i = 0; i < pool.length && picked.length < n; i++) {
      var p = pool[i];
      var mine = spec.player && spec.intent === 'list';            // "Mahomes": every line on him
      if (picked.indexOf(p) >= 0) continue;
      if (who[WHO(p) + (mine ? p.mkt : '')]) continue;
      if (!mine && (spec.one_per_game !== false || spec.intent === 'parlay') && games[p.gid]) continue;
      var mkey = p.sport + '|' + (p.mkt || p.kind);
      if (pass === 0 && (mkts[mkey] || 0) >= mcap) continue;
      mkts[mkey] = (mkts[mkey] || 0) + 1;
      who[WHO(p) + (mine ? p.mkt : '')] = 1; games[p.gid] = 1; picked.push(p);
      if (spec.intent === 'parlay' && spec.target_price && !spec.count_set && picked.length >= 2 && ticket(picked).price >= spec.target_price) break;
    }
      if (mcap === 99 || (spec.intent === 'parlay' && spec.target_price && !spec.count_set && picked.length >= 2 && ticket(picked).price >= spec.target_price)) break;
    }
    // a parlay short of its legs (few games left on the board) fills from games it
    // already uses: an SGP+ (same-game legs plus other games), never one player twice
    if ((spec.intent === 'parlay' || spec.intent === 'rr') && picked.length < n) {
      for (var j = 0; j < pool.length && picked.length < n; j++) {
        var q = pool[j];
        if (who[WHO(q)] || picked.indexOf(q) >= 0) continue;
        if (picked.some(function (x) { return x.gid === q.gid && x.kind === q.kind && q.kind !== 'prop'; })) continue;  // one game line of each kind
        who[WHO(q)] = 1; picked.push(q);
      }
    }
    if (spec.intent === 'parlay' && spec.target_price && !spec.count_set) {          // the filler pass can overshoot: stop at the target
      for (var z = 2; z <= picked.length; z++) if (ticket(picked.slice(0, z)).price >= spec.target_price) { picked = picked.slice(0, z); break; }
    }
    var out = {rows: picked, pool: pool.length, two: two, two_onyx: twoOnyx, note: note};
    if (spec.intent === 'rr' && picked.length >= 2) {
      var k = Math.max(2, Math.min(picked.length - 1 || 2, spec.rr_size || 2)), combos = [];
      (function pick(start, cur) {
        if (cur.length === k) { combos.push(Object.assign(ticket(cur), {legs: cur.map(function (x) { return picked.indexOf(x) + 1; })})); return; }
        for (var c2 = start; c2 < picked.length; c2++) pick(c2 + 1, cur.concat([picked[c2]]));
      })(0, []);
      out.rr = {by: k, combos: combos, hit: combos.reduce(function (a, c3) { return a + c3.prob; }, 0) / combos.length};
    }
    if (spec.intent === 'parlay' && picked.length > 1) {
      out.parlay = ticket(picked);
      var g = {}; picked.forEach(function (x) { g[x.gid] = (g[x.gid] || 0) + 1; });
      out.parlay.sgp_plus = Object.keys(g).length < picked.length;
    }
    return out;
  }
  function ticket(legs) {
    var d = 1, pr = 1;
    legs.forEach(function (p) { d *= dec(p.price); pr *= p.conf; });
    return {price: am(d), prob: pr, sels: legs.map(function (p) { return p.sel; }).filter(Boolean)};
  }

  // ── same-game parlay: legs from one game that win TOGETHER ───────────────
  // Every game gets one storyline, set by its best leg (the anchor): a shootout
  // (the total over, players' overs, the anchor team covering) or a grinder (the
  // total under, players' unders). Only legs that fit the story join, one per
  // player, best first; the game whose story the models like most wins.
  // The product of the chances understates a correlated ticket (when the story
  // happens, its legs hit together), so the page calls it a floor.
  function fits(story, anchor, p) {
    if (p.kind === 'total' || p.mkt === 'q1_total') return p.side === story;
    if (p.kind === 'prop') {
      if (p.mkt === 'anytime_td') return story === 'over' && (!anchor.team || p.team === anchor.team || anchor.kind === 'total');
      return p.side === story && (story === 'under' || !anchor.team || anchor.kind === 'total' || p.team === anchor.team || anchor.kind !== 'prop');
    }
    if (p.kind === 'spread' || p.kind === 'ml') return story === 'over' && (anchor.kind === 'total' || p.name === anchor.team || p.name === anchor.name);
    return false;
  }
  function sgp(spec, pool, key) {
    var n = Math.max(2, Math.min(6, spec.count || 3)), by = {};
    pool.forEach(function (p) { if (p.kind !== 'ml' || p.price >= -150) (by[p.gid] = by[p.gid] || []).push(p); });
    var best = null;
    Object.keys(by).forEach(function (gid) {
      var G = by[gid];
      for (var a = 0; a < Math.min(3, G.length); a++) {           // try the game's top three anchors
        var anchor = G[a], story = anchor.kind === 'prop' || anchor.kind === 'total' ? anchor.side : 'over';
        var legs = [anchor], who = {}; who[WHO(anchor)] = 1;
        var kinds = {}; kinds[anchor.kind + (anchor.kind === 'prop' ? '' : anchor.name)] = 1;
        for (var i = 0; i < G.length && legs.length < n; i++) {
          var p = G[i];
          if (p === anchor || who[WHO(p)] || !fits(story, anchor, p)) continue;
          if (p.kind !== 'prop' && kinds[p.kind]) continue;          // one game line of each kind
          who[WHO(p)] = 1; kinds[p.kind] = 1; legs.push(p);
        }
        if (legs.length < 2) continue;
        var t = ticket(legs), score = legs.length * 10 + t.prob;    // the full ticket first, then the likeliest
        if (!best || score > best.score) best = {legs: legs, story: story, t: t, score: score};
      }
    });
    if (!best) return {rows: [], pool: pool.length, sgp: true};
    var g = best.legs[0];
    return {rows: best.legs, pool: pool.length, sgp: true, parlay: Object.assign(best.t, {same_game: true,
      story: best.story === 'over' ? 'Shootout script: every leg wins together if this game runs high-scoring' : 'Grinder script: every leg wins together if this game stays slow and low-scoring',
      matchup: g.matchup})};
  }

  // ── what the spec understood, in plain words ────────────────────────────
  var MW = {pts: 'points', reb: 'rebounds', ast: 'assists', q1_total: '1st-quarter totals', rec: 'receptions', rec_yds: 'receiving yards',
            rush_yds: 'rushing yards', pass_yds: 'passing yards', pass_td: 'passing TDs', pass_att: 'pass attempts', rush_rec_yds: 'rushing + receiving yards', pass_rush_yds: 'passing + rushing yards', anytime_td: 'anytime TD', first_td: 'first TD', first_basket: 'first basket', h1_total: '1st-half totals', two_plus_td: '2+ touchdowns', three_td: '3+ touchdowns', spread: 'spreads', total: 'totals', ml: 'moneylines'};
  function describe(s) {
    var b = [];
    b.push(s.intent === 'parlay' && s.target_price && !s.count_set ? 'parlay' : s.intent === 'rr' ? 'round robin of ' + (s.count || 4) + ' by ' + (s.rr_size || 2) + 's' : s.intent === 'sgp' ? (s.count || 3) + '-leg same-game parlay, correlated' : s.intent === 'parlay' ? (s.count || 3) + '-leg parlay' : (s.count || 5) === 1 ? 'top play' : 'top ' + (s.count || 5));
    b.push((s.sports || []).length ? s.sports.map(function (k) { return LG[k] || k; }).join(' + ') : 'every sport');
    if ((s.markets || []).length) b.push(s.markets.map(function (m) { return MW[m] || m; }).join(', '));
    if (s.side && s.side !== 'any') b.push(s.side === 'over' ? 'overs only' : 'unders only');
    if (s.target_price) b.push((s.ticket_floor ? 'ticket pays +' + s.target_price + ' or more' : 'pays about +' + s.target_price));
    if (s.min_price != null) b.push((s.default_floor ? 'standard prices, nothing shorter than ' : 'no price shorter than ') + (s.min_price > 0 ? '+' : '') + s.min_price);
    if (s.max_price != null) b.push('no price longer than ' + (s.max_price > 0 ? '+' : '') + s.max_price);
    if (s.min_conf != null) b.push(s.default_conf ? (s.intent === 'list' ? 'every pick 50%+ to hit' : 'every leg 50%+ to hit') : Math.round(100 * s.min_conf) + '%+ confidence');
    if (s.player) b.push(s.player);
    if (s.when) b.push(s.when === 'today' ? 'tonight' : s.when);
    if (s.slot) b.push(s.slot.label);
    if (s.school) b.push(s.school);
    else if (s.team_name) b.push(s.team_name);
    else if (s.team && !(s.teams || []).length) b.push(s.team);
    if (s.conf) b.push(s.conf + ' teams');
    if (s.onyx_picks) b.push('Onyx Picks only');
    b.push(s.sort === 'proj' ? 'highest projection first' : s.sort === 'rec' ? 'what we recommend most first' : s.sort === 'price' ? 'biggest payouts first' : s.sort === 'edge' ? (s.td_fav ? 'our TD model\'s favorites against their price first' : 'best value first') : s.sort === 'two_td' ? 'most likely 2+ TDs first' : 'highest confidence first');
    return b.join(' · ');
  }

  // the last answer, for follow-ups ("swap leg 2", "make it +500"); reset() starts fresh
  var LAST = null;
  function reset() { LAST = null; }
  // the built-in follow-up: "swap / replace / drop leg 2", "not Mahomes" on the last answer
  function localFollow(q) {
    if (!LAST) return null;
    var t = q.toLowerCase(), m = t.match(/\b(swap|replace|change|drop|remove|sub|switch)( out)? (leg|pick|play)? ?#?(\d)\b/);
    if (m && LAST.legs[+m[4] - 1]) {
      var x = Object.assign({}, LAST.spec, {exclude: (LAST.spec.exclude || []).concat([LAST.legs[+m[4] - 1].name])});
      if (/\bdrop|remove\b/.test(m[1]) && x.intent !== 'list') x.count = Math.max(1, (x.count || 3) - 1);
      return x;
    }
    return null;
  }
  function toSpec(q, B) {
    return aiUrl().then(function (u) {
      var lf = localFollow(q);
      if (!u) return {spec: lf || localSpec(q, B), via: 'local'};
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 15000);
      var ctx = LAST ? {q: LAST.q, spec: LAST.spec, legs: LAST.legs} : null;
      // the built-in reader's take goes along (tested on 500 phrasings): the AI starts from it and
      // corrects only what it misread, so nothing the parser has learned is lost
      var hint = null; try { hint = lf || localSpec(q, B); } catch (e) { hint = null; }
      return fetch(u, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({q: q, ctx: ctx, hint: hint}), signal: ctl.signal})
        .then(function (r) { clearTimeout(tm); if (!r.ok) throw new Error('relay ' + r.status); return r.json(); })
        .then(function (j) { if (!j || !j.spec) throw new Error('no spec'); return {spec: blend(j.spec, hint, q, !ctx || !FOLLOWW.test(String(q).toLowerCase().replace(/same[- ]game/g, ''))), say: j.say || '', clarify: hint && (hint.tabbr || hint.ambig || hint.depth || hint.conf || hint.onyx_picks) ? null : j.clarify || null, via: 'ai'}; })   // the reader's team, conference, depth or picks reading is not a question
        .catch(function () { return {spec: lf || localSpec(q, B), via: 'local'}; });
    });
  }
  // the AI's read on an answer, from the legs' own numbers (null without the relay)
  function explain(R, q) {
    if (!R || !R.rows || !R.rows.length) return Promise.resolve(null);
    return aiUrl().then(function (u) {
      if (!u) return null;
      var legs = R.rows.slice(0, 8).map(function (p, i) {
        var o = {n: i + 1, play: p.label, game: p.matchup, price: p.price, conf: Math.round(1000 * p.conf) / 10, edge: Math.round(1000 * p.edge) / 10, tag: p.tag || 'lean'};
        if (p.model != null) o.model = Math.round(1000 * p.model) / 10;
        if (p.proj != null) { o.proj = p.proj; o.line = p.line; }
        if (p.two != null) o.two_td = Math.round(1000 * p.two) / 10;
        return o;
      });
      var ticket = R.parlay ? {legs: R.rows.length, price: R.parlay.price, all_hit: Math.round(1000 * R.parlay.prob) / 10, same_game: !!R.parlay.same_game} : null;
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 20000);
      return fetch(u, {method: 'POST', headers: {'content-type': 'application/json'}, signal: ctl.signal,
                       body: JSON.stringify({explain: {q: q, legs: legs, ticket: ticket, note: R.note || ''}})})
        .then(function (r) { clearTimeout(tm); return r.ok ? r.json() : null; })
        .then(function (j) { return j && j.text ? j.text : null; })
        .catch(function () { return null; });
    });
  }
  // mainstream by default: unless the request names its own odds, no parlay leg
  // shorter than -150 and no single shorter than -200 (no -2800 "locks")
  // the teams a request names: "teams" (several) or "team" (one), as board abbreviations
  function teamsFor(spec, sport, TL) {
    if (spec.tabbr && typeof spec.tabbr === 'object') return (spec.tabbr[sport] || []).map(function (x) { return String(x || '').toUpperCase(); });
    return TL || teamList(spec);
  }
  function teamList(spec) {
    var a = (spec.teams && spec.teams.length ? spec.teams : spec.team ? [spec.team] : []);
    return a.map(function (x) { return String(x || '').toUpperCase().trim(); }).filter(Boolean);
  }
  function onTeams(p, TL) {
    var hay = [p.team, p.matchup, p.name].join(' ').toUpperCase();
    return TL.some(function (T) { return new RegExp('(^|[^A-Z])' + T + '([^A-Z]|$)').test(hay); });
  }
  // the AI's reading, kept honest by the built-in reader on what the reader is proven at
  // (tested on 500 phrasings): props only, a price bound the AI left out, and never a sport
  // or a confidence floor nobody asked for
  var SPORTWORD = /\b(nfl|nba|nhl|ncaa[fbm]?|cfb|cbb|college|football|basketball|hockey|tennis|atp|wta|hoops|pro football|march madness)\b/;
  // words that make a question lean on the one before it ("make it 4", "swap that", "same but unders")
  var FOLLOWW = /\b(it|its|that|those|these|them|they|instead|same|another|swap|more|less|fewer|add|also|again|replace|drop|remove|change|switch|but|too|rather|other)\b/;
  function blend(ai, h, q, fresh) {
    if (!h) return ai;
    var s = Object.assign({}, ai), t = String(q || '').toLowerCase(), before = JSON.stringify(ai);
    if (h.props_only) s.props_only = true;
    // a price rule the reader found wins (100% on prices across 80,000+ generated requests; the AI
    // read "even money" as exactly +100, which matches almost nothing)
    if (h.min_price != null) s.min_price = h.min_price;
    if (h.ticket_floor) { s.min_price = null; s.ticket_floor = true; }
    if (h.max_price != null) s.max_price = h.max_price;
    if ((h.min_price != null || h.max_price != null) && h.min_price == null && s.min_price != null && s.max_price === h.max_price && s.min_price > s.max_price) s.min_price = null;
    if (s.min_conf != null && h.min_conf == null && !/%|percent/.test(t)) s.min_conf = null;
    if ((s.sports || []).length && !(h.sports || []).length && !teamList(s).length && !s.player && !SPORTWORD.test(t)) s.sports = [];
    if (!teamList(s).length && (h.teams || []).length > 1) { s.teams = h.teams; s.team = null; }
    else if (!teamList(s).length && h.team) s.team = h.team;
    if (!s.player && h.player && !(s.exclude || []).length) s.player = h.player;
    // the AI kept part of the name ("Cameron"): the reader's full name ("Josh Cameron")
    if (s.player && h.player && s.player !== h.player && String(h.player).toLowerCase().split(/\s+/).indexOf(String(s.player).toLowerCase()) >= 0) s.player = h.player;
    if ((h.exclude || []).length && !(s.exclude || []).length) s.exclude = h.exclude.slice();
    // what they ruled out, from the built-in reader: the AI never turns "no first basket" back into the market (11/6)
    if (h.xmk) { s.xmk = h.xmk.slice(); s.markets = (s.markets || []).filter(function (m) { return h.xmk.indexOf(m) < 0; }); }
    if (h.no_props) { s.no_props = true; s.props_only = false; }
    if (h.props_only && !s.props_only) s.props_only = true;
    if (h.unsupported) s.unsupported = h.unsupported;
    // what the reader knows that the AI's schema does not carry (11/2): every team by name per sport
    // (a college name is never a pro team), conferences, a name two teams share (ask, never guess),
    // depth questions and Onyx Picks. Its teams and sports win: the AI once put "Duke" in the NBA.
    ['tabbr', 'school', 'conf', 'ambig', 'depth', 'onyx_picks', 'col_alt', 'slot'].forEach(function (k) { if (h[k] != null) s[k] = h[k]; });
    if (h.tabbr || h.ambig) { s.team = h.team || null; s.teams = (h.teams || []).slice(); if ((h.sports || []).length) s.sports = h.sports.slice(); }
    if ((h.sports || []).length && (CBBW.test(t) || CFBW.test(t) || /\bcollege\b|\bncaa\b/.test(t))) s.sports = h.sports.slice();
    if ((h.exclude || []).length && s.player && h.exclude.indexOf(s.player) >= 0) s.player = null;
    if ((h.teams || []).length > 1 && teamList(s).length < 2) { s.teams = h.teams.slice(); s.team = null; }
    // a payout the reader read ("3x" is +200) wins over the AI's reading of it
    if (h.target_price != null) s.target_price = h.target_price;
    // a scattershot list of markets nobody named (3+ where the reader found none) is the AI guessing
    if ((s.markets || []).length >= 3 && !(h.markets || []).length) s.markets = [];
    // a market the reader found by name ("boards" = rebounds) wins over the AI dropping or swapping it
    // (1,000 live-AI requests: all 8 misses were this)
    if ((h.markets || []).length && JSON.stringify((s.markets || []).slice().sort()) !== JSON.stringify(h.markets.slice().sort())) s.markets = h.markets.slice();
    if ((!s.side || s.side === 'any') && (h.side === 'over' || h.side === 'under')) s.side = h.side;
    // a fresh question (not a follow-up): ticket type, leg count and teams nobody named follow the
    // reader, so the same words get the same answer every time (60 questions asked 3 times each:
    // the AI wobbled between 1 and 5 picks on single-player asks and once made a parlay of 3 unnamed teams)
    if (s.teams && s.teams.length > 1) s.teams = s.teams.slice().sort();
    if (fresh) {
      if (s.intent !== h.intent && h.intent === 'list' && !/\b(parlay|parly|legs?|legger|sgp|same[- ]game|round robin|rr|ticket|combo)\b/.test(t)) s.intent = 'list';
      if (s.intent === h.intent && s.count !== h.count) { s.count = h.count; s.count_set = !!h.count_set; }
      if (s.player && !h.team && !(h.teams || []).length) { s.team = null; s.teams = []; }
    }
    // a day nobody named
    if (s.when && !h.when && !/\b(today|tonight|tomorrow|weekend|this week|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/.test(t)) s.when = null;
    if (JSON.stringify(s) !== before) s._fixed = true;     // the AI's one-line reply may describe what it misread: drop it
    return s;
  }
  // nothing to build because the named teams or player have no game left on the board (it has
  // started, or they don't play): ask what to build instead, with real games to tap
  function clarifyFor(spec, B) {
    var TL = teamList(spec), now = Date.now();
    if (!TL.length && !spec.player) return null;
    var who = function (p) { return TL.length ? onTeams(p, teamsFor(spec, p.sport, TL)) && teamsFor(spec, p.sport, TL).length > 0 : String(p.name || p.label).toLowerCase().indexOf(String(spec.player).toLowerCase()) >= 0; };
    var sp = (spec.sports || []).length ? spec.sports : null;
    var mine = B.filter(function (p) { return (!sp || sp.indexOf(p.sport) >= 0) && who(p); });
    if (mine.some(function (p) { return Date.parse(p.start) > now; })) return null;    // they have plays; something else emptied it
    var g = {}, live = [];
    mine.forEach(function (p) { if (!g[p.gid]) { g[p.gid] = 1; var mm = String(p.matchup || '').split(' vs '); live.push(mm.length === 2 ? mm[1] + ' @ ' + mm[0] : p.matchup); } });
    var nm = TL.length ? TL.join(', ') : spec.player;
    var none = TL.filter(function (T) { return !mine.some(function (p) { return onTeams(p, [T]); }); });
    if (spec.school) nm = spec.school;
    var question = (none.length && live.length ? none.join(', ') + (none.length > 1 ? ' have' : ' has') + ' no game on today\'s Onyx board, and ' : '')
      + (live.length
        ? (live.length === 1 ? live[0] + ' has' : live.join(' and ') + ' have') + ' already started. We build from Onyx\'s pregame prices, so in-game bets are not on our board yet. What should I build instead?'
        : 'There is no game for ' + nm + ' on today\'s Onyx board. What should I build instead?');
    var seen = {}, opts = [];
    B.filter(function (p) { return Date.parse(p.start) > now && (!sp || sp.indexOf(p.sport) >= 0); })
      .sort(function (a, b) { return Date.parse(a.start) - Date.parse(b.start); })
      .forEach(function (p) {
        if (seen[p.gid] || opts.length >= 3) return; seen[p.gid] = 1;
        var m = String(p.matchup || '').match(/^([A-Z0-9]+) (?:@|vs) ([A-Z0-9]+)$/);
        if (!m) return;
        var day = new Date(p.start).toLocaleDateString('en-US', {weekday: 'long', timeZone: 'America/New_York'});
        var away = p.matchup.indexOf('@') > 0 ? m[1] : m[2], home = p.matchup.indexOf('@') > 0 ? m[2] : m[1];
        opts.push({label: 'The same from ' + away + ' @ ' + home + ' (' + day + ')',
                   spec: Object.assign({}, spec, {teams: [m[1], m[2]], team: null, player: null, school: null, col_alt: null, sports: [p.sport], tabbr: (function () { var o = {}; o[p.sport] = [m[1], m[2]]; return o; })()})});
      });
    opts.push({label: 'The same from any game still to play', spec: Object.assign({}, spec, {teams: [], team: null, player: null, school: null, col_alt: null, tabbr: null})});
    return {question: question, options: opts};
  }
  function normalize(spec) {
    var s = Object.assign({intent: 'list', count: 5, sports: [], markets: [], side: 'any', sort: 'conf', one_per_game: true}, spec || {});
    s.sports = (s.sports || []).filter(function (x, i, a) { return a.indexOf(x) === i; });   // the AI once sent ["cfb", "cfb", "cfb"]
    var two = (s.markets || []).indexOf('two_plus_td') >= 0 || s.sort === 'two_td';
    var longMkt = (s.markets || []).some(function (m) { return m === 'first_td' || m === 'first_basket' || m === 'anytime_td' || m === 'three_td'; });
    // a named team or player: every line on them, at any price ("Buckeyes moneyline" at -400 is still the answer)
    // a parlay is only as good as its weakest leg: every leg more likely than not, unless the
    // request asks for dogs, longshots or a payout (then the price filters decide)
    // (and a list of picks the same: a 17% play is not a pick, unless dogs or longshots were asked for)
    if ((s.intent === 'parlay' || s.intent === 'list' || s.intent === 'rr') && s.min_conf == null && !s.target_price && s.sort !== 'price' && !(s.min_price != null && s.min_price >= 100) && !longMkt && !two) { s.min_conf = 0.5; s.default_conf = true; }
    if (s.min_price == null && s.max_price != null && s.max_price < 0) { s.min_price = Math.min(-250, s.max_price - 100); s.default_floor = true; }   // "-150 or shorter": down to -250, no -2800 locks
    if (s.min_price == null && !two && !longMkt && !teamList(s).length && !s.player && !s.conf) { s.min_price = s.intent === 'list' ? -200 : -150; s.default_floor = true; }
    // a list ranked by projection is the projections, every one (11/8: "just the top 5 QB passing yard projections"
    // came back trimmed to 50%+ overs at standard prices); the pick floors are for picks
    if (s.intent === 'list' && s.sort === 'proj') { if (s.default_conf) { s.min_conf = null; s.default_conf = false; } if (s.default_floor) { s.min_price = null; s.default_floor = false; } }
    if (teamList(s).length === 1 && s.intent === 'list') s.one_per_game = false;      // "Ohio State player props": several from the one game
    // Onyx Picks: every logged pick, at the price it was logged under the picks rule (40%+ chance,
    // -150 to +200), not trimmed by the floors a search of projections gets
    if (s.onyx_picks && s.intent === 'list') {
      if (s.default_conf) { s.min_conf = null; s.default_conf = false; }
      if (s.default_floor) { s.min_price = null; s.default_floor = false; }
      if (!s.count_set) s.count = 25;
      s.one_per_game = false;
    }
    return s;
  }
  // ── depth charts (11/2): "who starts for Duke", "Kentucky's pace", "projected minutes Cooper Flagg".
  // Answered from data/<sport>/depth.json (our minutes and stat projections), never from a guess,
  // with a link to that team's full depth chart. Projections, not picks.
  var DEPTHD = {};
  function loadDepth(sp) { if (!DEPTHD[sp]) DEPTHD[sp] = getJSON('data/' + sp + '/depth.json').catch(function () { return null; }); return DEPTHD[sp]; }
  var DEPW = /^(starts|start|starting|starter|starters|minutes|mins|pace|tempo|depth|chart|charts|lineup|lineups|rotation|usage|projected|expected|playing|time|tonight|today|team|teams|whos|who|for|the|his|what|whats|does|play|plays|how|many|much|get|gets|will|is|are|on|in|of|at|and|show|me|give|snap|snaps|share|counts|ice)$/;
  function depthAnswer(spec, B, q, via) {
    var tab = spec.tabbr && typeof spec.tabbr === 'object' ? spec.tabbr : null, TL = teamList(spec);
    var want = (spec.sports || []).filter(function (x) { return DEPTHPG[x]; });
    if (!want.length || !tab) want = tab ? Object.keys(tab).filter(function (x) { return DEPTHPG[x]; }) : ['nba', 'cbb', 'nfl', 'cfb', 'nhl'];
    var what = (spec.depth || {}).what || 'chart', text = ' ' + ((spec.depth || {}).text || '') + ' ';
    return Promise.all(want.map(loadDepth)).then(function (Ds) {
      var teams = [], players = [];
      want.forEach(function (sp, i) {
        var D = Ds[i]; if (!D || !D.teams) return;
        var abs = tab ? (tab[sp] || []) : TL;
        abs.forEach(function (ab) { if (D.teams[ab]) teams.push({sp: sp, ab: ab, T: D.teams[ab], D: D}); });
        // a player by name: the full name, or a last name of 4+ letters (within the team, when one is named)
        var pn = spec.player ? cnorm(spec.player) : '';
        Object.keys(D.teams).forEach(function (ab) {
          if (abs.length && abs.indexOf(ab) < 0) return;
          (D.teams[ab].players || []).forEach(function (p) {
            var n = cnorm(p.n).replace(/ (jr|sr|ii|iii|iv)$/, ''), last = n.split(' ').pop(), sc = 0;
            if (text.indexOf(' ' + n + ' ') >= 0 || text.indexOf(' ' + cnorm(p.n) + ' ') >= 0) sc = 4;           // the full name as typed
            else if (pn && (n === pn || cnorm(p.n) === pn)) sc = 3;
            else if (last.length >= 4 && !DEPW.test(last) && !NOT_NAMES.test(last) && text.indexOf(' ' + last + ' ') >= 0) sc = 1;
            if (sc) players.push({sc: sc, sp: sp, ab: ab, T: D.teams[ab], D: D, p: p});
          });
        });
      });
      var top = players.length ? Math.max.apply(null, players.map(function (x) { return x.sc; })) : 0;
      players = players.filter(function (x) { return x.sc === top; }).sort(function (a, b) { return (b.p.use || 0) - (a.p.use || 0); });
      var base = {rows: [], pool: 0, spec: spec, via: via, say: ''};
      // a last name several players share, and no team named: ask which
      var distinct = {}; players.forEach(function (x) { distinct[x.sp + x.p.n] = x; });
      var dl = Object.keys(distinct).map(function (k) { return distinct[k]; });
      if (top === 1 && dl.length > 1 && !teams.length) {
        return Object.assign(base, {understood: 'Depth chart · which player?', clarify: {question: 'Our depth charts have ' + dl.length + ' players by that name. Which one?',
          options: dl.slice(0, 6).map(function (x) { var o = {}; o[x.sp] = [x.ab]; return {label: x.p.n + ' (' + x.T.name + ', ' + LG[x.sp] + ')',
            spec: Object.assign({}, spec, {depth: {what: what, text: cnorm(x.p.n)}, player: null, team: x.ab, teams: [], tabbr: o, sports: [x.sp], ambig: null})}; })}});
      }
      function statsOf(D, p) {
        var out = [], lab = D.labels || {pts: 'pts', reb: 'reb', ast: 'ast', '3pm': '3pm'};
        (D.stats || []).forEach(function (k) { var v = (p.proj || {})[k]; if (v == null) v = (p.now || {})[k]; if (v != null && out.length < 4) out.push([lab[k] || k, Math.round(v * 10) / 10]); });
        return out;
      }
      function row(D, p) { return {n: p.n, pos: p.pos || '', role: p.role || '', tier: p.tier || '', tag: p.tag || '', use: p.use, stats: statsOf(D, p)}; }
      function unit(D) { return D.unit === 'min' ? 'MIN' : D.unit === 'toi' ? 'TOI' : D.unit === 'snap%' ? 'SNAP %' : 'USE %'; }
      function link(sp, ab) { return DEPTHPG[sp] + (sp === 'nba' ? '' : encodeURIComponent(ab)); }
      function paceRank(D, T) { var ps = Object.keys(D.teams).map(function (k) { return D.teams[k].pace; }).filter(function (x) { return x != null; }).sort(function (a, b) { return b - a; }); return [ps.indexOf(T.pace) + 1, ps.length]; }
      function paceLabel(sp, D) { return D.pace_label || (sp === 'cbb' ? 'possessions per 40 minutes' : sp === 'nba' ? 'possessions per 48 minutes' : 'pace'); }
      var secs = [];
      if (players.length && (top >= 3 || !teams.length || players.some(function (x) { return teams.some(function (t2) { return t2.ab === x.ab && t2.sp === x.sp; }); }))) {
        dl.slice(0, 2).forEach(function (x) {
          secs.push({sport: x.sp, lg: LG[x.sp], team: x.T.name, abbr: x.ab, unit: unit(x.D), focus: x.p.n, link: link(x.sp, x.ab), rows: [row(x.D, x.p)],
            pace: x.T.pace, pace_label: paceLabel(x.sp, x.D)});
        });
      } else {
        teams.slice(0, 2).forEach(function (h) {
          var P = (h.T.players || []).slice();
          if (what === 'start') { var st = P.filter(function (p) { return /starter/i.test(p.role || '') || /starter/i.test(p.tier || '') || /^(QB1|RB1|WR1|WR2|WR3|TE1|L1|D1|G1)$/.test(p.role || ''); }); if (st.length) P = st; }
          P = P.sort(function (a, b) { return (b.use || 0) - (a.use || 0); }).slice(0, what === 'start' ? 11 : 8);
          var pr = paceRank(h.D, h.T);
          secs.push({sport: h.sp, lg: LG[h.sp], team: h.T.name, abbr: h.ab, unit: unit(h.D), link: link(h.sp, h.ab), rows: P.map(function (p) { return row(h.D, p); }),
            pace: h.T.pace, pace_label: paceLabel(h.sp, h.D), pace_rank: pr[0] ? pr : null});
        });
      }
      // basketball first (minutes, starters and pace are its words), football first for a football question
      var hoopF = function (x) { return x.sport === 'cbb' || x.sport === 'nba' ? 0 : 1; };
      secs.sort(function (a, b) { return (spec.depth || {}).foot ? hoopF(b) - hoopF(a) : hoopF(a) - hoopF(b); });
      var who = secs.length ? (secs[0].focus ? secs[0].focus + ' (' + secs[0].team + ')' : secs.map(function (x) { return x.team + ' (' + x.lg + ')'; }).join(' and ')) : '';
      var W = {start: 'projected starters', min: 'projected minutes', pace: 'pace', chart: 'depth chart'}[what];
      return Object.assign(base, {depth: secs, understood: (W.charAt(0).toUpperCase() + W.slice(1)) + (who ? ' · ' + who : ''),
        note: secs.length ? 'From our depth model: projected ' + secs.map(function (x) { return x.unit === 'MIN' ? 'minutes' : x.unit === 'TOI' ? 'ice time' : x.unit === 'SNAP %' ? 'snap share' : 'usage share'; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(' and ') + ' with per-game numbers. Projections, not picks.'
          + (secs.some(function (x) { return x.sport === 'cbb'; }) ? ' College basketball player props are not on our board yet.' : '')
          : 'That team or player is not in our depth charts (NBA, college basketball, NFL, college football and NHL). Try the full team name, or open a sport\'s Depth tab.'});
    });
  }
  // + and - (11/8, Jordan: "add and remove all of these, maybe pluses and minuses"): "-Brunson" and "-first basket"
  // read as "no Brunson", "no first basket"; "+points" and "+Knicks" as the words themselves. Only a sign that
  // starts a word and is followed by a letter: "-150", "+2000", "o/u", "same-game" are untouched.
  function plusMinus(q) {
    q = String(q);
    // clause mode (11/8, Jordan: "top 4 nfl td scorers + 1 PM slate only - Jonathan Taylor + total odds of at least
    // +700"): once " + " separates the rules, " - " in front of a word takes it out too
    // ("passing + rushing yards", "points + rebounds" are one market: a + between stat words stays)
    var STATW = '(?:points?|pts|rebounds?|rebs?|reb|assists?|asts?|ast|passing|pass|rushing|rush|receiving|rec|yards|yds|threes|3s|blocks?|steals?|pra|p|r|a)';
    var SEP = new RegExp('(?<!\\b' + STATW + ')\\s\\+\\s+(?!' + STATW + '\\b)(?=[a-z0-9])', 'gi');
    if (SEP.test(q)) { SEP.lastIndex = 0; q = q.replace(SEP, ', ').replace(/(^|[\s,])-\s+(?=[a-z])/gi, '$1 no '); }
    return q.replace(/(^|[\s,;(])-(?=[a-z])/gi, '$1 no ').replace(/(^|[\s,;(])\+(?=[a-z])/gi, '$1 ').replace(/\s+/g, ' ').trim();
  }
  // the reading as chips the reader can take off one at a time (the − on each), each with the spec patch that
  // removes it; the leg count is stepped with + and − (askStep in home.html)
  function chipBase(s) {
    var b = Object.assign({}, s);
    if (b.default_conf) { b.min_conf = null; b.default_conf = false; }
    if (b.default_floor) { b.min_price = null; b.default_floor = false; }
    delete b._fixed; delete b.ambig;
    return b;
  }
  function chips(s) {
    var out = [], T = function (label, patch, neg) { out.push({label: label, patch: patch, neg: !!neg}); };
    var od = function (x) { return (x > 0 ? '+' : '') + x; };
    (s.sports || []).forEach(function (k) { T(LG[k] || k, {sports: s.sports.filter(function (x) { return x !== k; })}); });
    (s.markets || []).forEach(function (m) { T(MW[m] || m, {markets: s.markets.filter(function (x) { return x !== m; })}); });
    if (s.side && s.side !== 'any') T(s.side === 'over' ? 'Overs' : 'Unders', {side: 'any'});
    if (s.player) T(s.player, {player: null});
    var tn = s.school || s.team_name || teamList(s).join(', ');
    if (tn && !s.conf) T(tn, {team: null, teams: [], tabbr: null, school: null, team_name: null, col_alt: null});
    if (s.conf) T(s.conf + ' teams', {conf: null, tabbr: null});
    (s.exclude || []).forEach(function (x) { T('No ' + x, {exclude: s.exclude.filter(function (y) { return y !== x; })}, true); });
    (s.xmk || []).forEach(function (m) { if (m === 'two_plus_td' || m === 'two_td' || ((m === 'first_td' || m === 'three_td') && s.xmk.indexOf('anytime_td') >= 0)) return;
      T('No ' + (MW[m] || m).toLowerCase(), {xmk: s.xmk.filter(function (y) { return y !== m; })}, true); });
    if (s.no_props) T('No player props', {no_props: false}, true);
    if (s.target_price) T((s.ticket_floor ? 'Pays +' : 'About +') + s.target_price, {target_price: null, ticket_floor: false});
    if (s.min_price != null && !s.default_floor) T('Shortest ' + od(s.min_price), {min_price: null});
    if (s.max_price != null) T('Longest ' + od(s.max_price), {max_price: null});
    if (s.min_conf != null && !s.default_conf) T(Math.round(100 * s.min_conf) + '%+ to hit', {min_conf: null});
    if (s.when) T(s.when === 'today' ? 'Tonight' : s.when, {when: null});
    if (s.slot) T(s.slot.label.charAt(0).toUpperCase() + s.slot.label.slice(1), {slot: null});
    if (s.onyx_picks) T('Onyx Picks only', {onyx_picks: false});
    return out;
  }
  function ask(q, forced) {
    q = plusMinus(String(q || '').trim().slice(0, 300));
    if (!q) return Promise.resolve(null);
    return loadBoards().then(function (B) { return Promise.all([forced ? {spec: forced, via: 'tap'} : toSpec(q, B), B]); }).then(function (a) {
      // a name more than one team goes by ("Wildcats", "Miami" in college, "Kings" when both play):
      // ask which, with each team as a button, never a guess (11/2)
      if (a[0].spec && a[0].spec.ambig && (a[0].spec.ambig.opts || []).length && !forced) {
        var am0 = a[0].spec.ambig, base0 = Object.assign({}, a[0].spec, {ambig: null, col_alt: null}), W0 = am0.word.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
        LAST = {q: q, spec: base0, legs: []};
        var cA = normalize(base0);
        return {rows: [], pool: 0, spec: cA, via: a[0].via, say: '', ambig: true, understood: 'Which ' + W0 + '? More than one team goes by that name',
                clarify: {question: 'More than one team goes by "' + W0 + '". Which one do you mean?', options: am0.opts.map(function (o) { return {label: o.label, spec: Object.assign({}, base0, o.patch)}; })}};
      }
      // the AI asked a question instead of guessing: show it, no plays
      if (a[0].clarify && a[0].clarify.question && (a[0].clarify.options || []).length) {
        var c0 = normalize(a[0].spec);
        LAST = {q: q, spec: a[0].spec, legs: []};
        return {rows: [], pool: 0, spec: c0, via: a[0].via, say: a[0].say || '', understood: describe(c0),
                clarify: {question: a[0].clarify.question, options: a[0].clarify.options.slice(0, 4).map(function (o) { return {label: o, q: o}; })}};
      }
      // depth charts, minutes, starters and pace: from data/<sport>/depth.json
      if (a[0].spec && a[0].spec.depth) return depthAnswer(a[0].spec, a[1], q, a[0].via);
      if (a[0].spec && a[0].spec.unsupported && !forced) {
        var u0 = normalize(a[0].spec), sp0 = (u0.sports || [])[0], SPN = {nba: 'NBA', nfl: 'NFL', cfb: 'college football', cbb: 'college basketball', nhl: 'NHL', tennis: 'tennis'};
        var on = {}; a[1].forEach(function (p) { if (Date.parse(p.start) > Date.now()) on[p.sport] = 1; });
        var spx = sp0 && on[sp0] ? SPN[sp0] : (on.nfl ? 'NFL' : on.nba ? 'NBA' : Object.keys(on).map(function (k) { return SPN[k]; })[0] || '');
        var who0 = u0.school || u0.player || (teamList(u0).length === 1 ? teamList(u0)[0] : null);
        var lines0 = spx === 'college basketball';     // game lines only on that board
        var opts = (who0 ? (lines0 ? [who0 + ' spread', who0 + ' moneyline', spx + ' best bets today', '3 leg ' + spx + ' parlay'] : [who0 + ' props', who0 + ' best bets', spx + ' best bets today', '3 leg ' + spx + ' parlay'])
                         : [spx + ' best bets today', '3 leg ' + spx + ' parlay', spx + ' plus money picks', lines0 ? spx + ' totals tonight' : 'safest ' + spx + ' props']).map(function (x) { x = x.replace(/\s+/g, ' ').trim(); return {label: x.charAt(0).toUpperCase() + x.slice(1), q: x}; });
        LAST = {q: q, spec: a[0].spec, legs: []};
        var un = String(a[0].spec.unsupported).split('|');
        return {rows: [], pool: 0, spec: u0, via: a[0].via, say: '', understood: 'Not in search: ' + un[0],
                clarify: {question: 'Search does not cover ' + un[0] + ' yet' + (un[1] ? ' (' + un[1] + ')' : '') + '. Want one of these instead?', options: opts}};
      }
      var spec = normalize(a[0].spec);
      var res = run(spec, a[1]), asked = spec;      // asked: the reading before any widening below
      // the standard-price floor left the ticket short (favorites, a thin board): widen it once and say so
      var want = spec.intent === 'list' ? 1 : (spec.count || 3);
      if (spec.default_floor && res.rows.length < want && spec.intent !== 'sgp') {
        var wide = Object.assign({}, spec, {min_price: -250});
        var r2 = run(wide, a[1]);
        if (r2.rows.length > res.rows.length) { res = r2; spec = wide; res.note = (res.note ? res.note + ' ' : '') + 'Not enough at standard prices (-150 or longer), so this reaches to -250.'; }
      }
      // the 50% floor left it short (a thin board, a market that is never 50%): show the most likely
      // instead, and say so, rather than an empty answer
      if (spec.default_conf && res.rows.length < want) {
        var loose = Object.assign({}, spec, {min_conf: null, default_conf: false});
        var r3 = run(loose, a[1]);
        if (r3.rows.length > res.rows.length) { res = r3; spec = loose; res.note = (res.note ? res.note + ' ' : '') + 'Nothing here is 50%+ to hit right now, so these are the most likely.'; }
      }
      // a same-game parlay of one game-line market cannot fill from one game (one moneyline, one
      // total): build it from that game's other markets too, and say so
      if (spec.intent === 'sgp' && res.rows.length < 2 && (spec.markets || []).length) {
        var wideS = Object.assign({}, spec, {markets: [], side: 'any'});
        var r4 = run(wideS, a[1]);
        if (r4.rows.length >= 2) { res = r4; res.widened = true; res.note = (res.note ? res.note + ' ' : '') + 'One game does not have enough of that market for a same-game parlay, so this adds the same game\'s other markets.'; }
      }
      // 11/6 (Jordan: "I haven't had 1 successful search"): never a dead end. When nothing matches,
      // widen what was asked one step at a time, each step said out loud: the day (late at night
      // tonight's games have started), then the price, then the confidence floor, then the side.
      var nf = spec.intent === 'list' ? 1 : spec.intent === 'sgp' ? 2 : Math.min(2, spec.count || 2);
      var steps = [
        [function (x) { return x.when; }, function (x) { return {when: null}; },
         function () { return 'Nothing left ' + (spec.when === 'today' ? 'tonight' : 'on ' + spec.when) + ' for that, so these are from the next games on the board.'; }],
        [function (x) { return x.min_price != null || x.max_price != null; }, function (x) { return {min_price: null, max_price: null, default_floor: false}; },
         function () { return 'Nothing at that price, so these are the closest prices on the board.'; }],
        [function (x) { return x.min_conf != null; }, function (x) { return {min_conf: null, default_conf: false}; },
         function () { return 'Nothing at that confidence right now, so these are the most likely.'; }],
        [function (x) { return x.side && x.side !== 'any'; }, function (x) { return {side: 'any'}; },
         function () { return 'No ' + (spec.side === 'over' ? 'overs' : 'unders') + ' matched, so this includes the other side.'; }]];
      // the steps add up (11/6: "Cowboys spreads tonight" needs both the day and the 50% floor let go;
      // one at a time found nothing): each step keeps the ones before it, and the answer says every one used
      var acc = spec, said = [], note0 = res.note || '';
      for (var si = 0; si < steps.length && res.rows.length < nf && !spec.onyx_picks && !spec.player; si++) {
        if (!steps[si][0](acc)) continue;
        acc = Object.assign({}, acc, steps[si][1](acc)); said.push(steps[si][2]());
        var r5 = run(acc, a[1]);
        if (r5.rows.length > res.rows.length) { res = r5; spec = acc; res.widened = true; res.note = (note0 ? note0 + ' ' : '') + said.join(' '); }
      }
      // a named team or game with nothing in the market asked for (no moneyline posted on a heavy favorite):
      // that game's other lines, said so (11/6)
      if (!res.rows.length && teamList(spec).length && (spec.markets || []).length && !spec.player) {
        var mw7 = {ml: 'moneyline', spread: 'spread', total: 'total'}[(spec.markets || [])[0]] || MW[(spec.markets || [])[0]] || 'line like that';
        var spT = Object.assign({}, spec, {markets: [], side: 'any', min_conf: null, default_conf: false, min_price: null, max_price: null, default_floor: false}), r7 = run(spT, a[1]);
        if (r7.rows.length) { res = r7; spec = spT; res.widened = true; res.note = (res.note ? res.note + ' ' : '') + 'No ' + mw7 + ' on the board for that game, so these are its other lines.'; }
      }
      // a player with nothing that matches: his other markets, then any day
      if (spec.player && res.rows.length < 1) {
        var sp3 = Object.assign({}, spec, {markets: [], side: 'any', when: null, min_price: null, max_price: null, min_conf: null, default_conf: false, default_floor: false}), r6 = run(sp3, a[1]);
        if (r6.rows.length) { res = r6; spec = sp3; res.widened = true; res.note = (res.note ? res.note + ' ' : '') + 'Nothing matched that exactly, so these are ' + spec.player + '\'s lines on the board.'; }
      }
      // never an empty answer without the reason (11/6, Jordan: the Knicks ask came back blank)
      if (!(res.rows || []).length && !res.note) {
        var SPW = {nba: 'NBA', nfl: 'NFL', cfb: 'college football', cbb: 'college basketball', nhl: 'NHL', tennis: 'tennis'};
        var nowE = Date.now(), sps = spec.sports || [];
        var fut = a[1].filter(function (p) { return Date.parse(p.start) > nowE && (!sps.length || sps.indexOf(p.sport) >= 0); });
        var tl = teamList(spec), tn = spec.school || spec.team_name || tl.join(', ');
        // the team field and the matchup, not a player's name ("Duke Watson" is not Duke)
        var onT = function (p) { var hay = ' ' + [p.team, p.matchup].join(' ').toUpperCase() + ' '; return tl.some(function (x) { return new RegExp('[^A-Z]' + String(x).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^A-Z]').test(hay); }); };
        if (!fut.length) res.note = 'No ' + (sps.length ? sps.map(function (x) { return SPW[x] || x; }).join(' or ') + ' ' : '') + 'games left on the board right now: today\'s have started or finished. The next slate shows here once its lines post.';
        else if (tl.length && !fut.some(onT)) res.note = (tn || 'That team') + (tl.length > 1 ? ' are' : ' is') + ' not on the board right now: no game with lines posted yet. Ask again once their next game is priced.';
        else if (spec.player && !fut.some(function (p) { return String(p.name || p.label).toLowerCase().indexOf(String(spec.player).toLowerCase()) >= 0; })) res.note = spec.player + ' has no line on the board right now.';
        else res.note = 'Nothing on the board fits all of that right now. Try fewer rules, a different market, or another day.';
      }
      // a payout no leg set on the board can reach at its per-leg share (2 legs at +1000 need +232 each):
      // the closest ticket instead of nothing (11/6)
      if (spec.target_price && (res.rows || []).length < 2 && (spec.intent === 'parlay' || spec.intent === 'sgp')) {
        var spL = Object.assign({}, spec, {no_leg_floor: true, sort: 'price'}), r8 = run(spL, a[1]);
        if (r8.rows.length > res.rows.length) { res = r8; spec = spL; }
      }
      // a payout the board could not reach: say what the closest ticket pays (11/6)
      if (spec.target_price && res.parlay && res.parlay.price != null && res.parlay.price < spec.target_price && (res.rows || []).length > 1) {
        res.note = (res.note ? res.note + ' ' : '') + 'Nothing on the board reaches +' + spec.target_price + ' with ' + res.rows.length + ' legs at these prices; the closest ticket pays ' + (res.parlay.price > 0 ? '+' : '') + res.parlay.price + '.';
      }
      // fewer than the number asked for: say so, never a silent short ticket (11/6)
      if ((spec.count_set || spec.conf || teamList(spec).length || spec.school) && spec.count && res.rows.length && res.rows.length < spec.count && !spec.target_price && !spec.onyx_picks) {
        var nn = res.rows.length, par = spec.intent === 'parlay' || spec.intent === 'sgp';
        res.note = (res.note ? res.note + ' ' : '') + 'Only ' + nn + (nn === 1 ? ' play' : ' plays') + ' on the board fit' + (spec.when === 'today' ? ' tonight' : '') +
          ', so this is ' + (par ? 'a ' + nn + '-leg ' + (spec.intent === 'sgp' ? 'same-game parlay' : 'parlay') : nn + ' instead of ' + spec.count) + '.';
      }
      // touchdown scorers: say why every edge reads negative, and what "favorite" means here
      if ((res.rows || []).some(function (r) { return /td$/.test(r.mkt || ''); })) {
        res.note = (res.note ? res.note + ' ' : '') + (spec.sort === 'rec' || spec.td_fav
          ? 'Favorites are the scorers our TD model rates highest against their price. Touchdown prices carry a big margin, so every edge reads negative, and the TD model has not beaten Onyx\'s price in testing yet.'
          : 'Touchdown prices carry a big margin (priced players score about 18% of the time against 22% implied), so every edge reads negative.');
      }
      res.spec = spec; res.asked = asked; res.via = a[0].via; res.say = a[0].say || ''; res.understood = describe(spec);
      var nowA = Date.now();
      // "Onyx picks": only logged picks. None today is said plainly, with what makes a pick (11/2)
      if (spec.onyx_picks && !res.rows.length && !forced) {
        var fin = (PICKS.final || []).map(function (m) { var x = String(m).split(':'); return (LG[x[0]] || x[0]) + ' ' + (MW[x[1]] || x[1]); });
        res.clarify = {question: 'No Onyx Picks ' + (PICKS.today.length ? 'match that' : 'are posted for games still to play today') + '. A play becomes an Onyx Pick only in a market that beat Onyx\'s prices on games our model never saw'
          + (fin.length ? ' (right now: ' + fin.join(', ') + ')' : '') + '; everything else is a projection. The full record is on the Onyx Picks page. Want our top projections instead?',
          options: [{label: 'Best bets today (projections)', spec: Object.assign({}, a[0].spec, {onyx_picks: false})}, {label: '3 leg parlay of our top projections', spec: Object.assign({}, a[0].spec, {onyx_picks: false, intent: 'parlay', count: 3, count_set: true})}]};
      }
      // a pro city with no game today when its college team plays ("Houston" on a college night): ask
      if (!res.rows.length && !res.clarify && (spec.col_alt || []).length) {
        var alts = spec.col_alt.filter(function (pt) { return Object.keys(pt.tabbr || {}).some(function (x) { return plays(a[1], x, pt.tabbr[x][0], nowA); }); });
        if (alts.length) res.clarify = {question: 'No ' + (spec.team || 'pro') + ' game on today\'s Onyx board. Did you mean ' + alts.map(function (pt) { return pt.school; }).join(' or ') + '?',
          options: alts.map(function (pt) { return {label: pt.school + ' (' + pt.sports.map(function (x) { return LG[x]; }).join(', ') + ')', spec: Object.assign({}, a[0].spec, pt, {col_alt: null})}; })};
      }
      if (!res.rows.length && !res.clarify) res.clarify = clarifyFor(spec, a[1]);
      // "your picks", "best bets": say which of these are Onyx Picks (logged and graded) and which are projections
      if (res.rows.length && spec.sort === 'rec' && /\bpicks?\b|\bbest bets?\b|\blocks?\b/.test(String(q).toLowerCase()) && !res.rows.some(function (r) { return r.pick; }))
        res.note = (res.note ? res.note + ' ' : '') + 'These are our top projections, not Onyx Picks: ' + (PICKS.today.length ? 'today\'s ' + PICKS.today.length + ' Onyx Pick' + (PICKS.today.length > 1 ? 's are' : ' is') + ' on the Onyx Picks page.' : 'no Onyx Pick is posted for games still to play today.');
      if (res.clarify || a[0].spec._fixed) res.say = '';
      if (teamList(spec).length > 1 && !spec.school) res.understood += ' · ' + teamList(spec).join(', ');
      if (spec.exclude && spec.exclude.length) res.understood += ' · without ' + spec.exclude.join(', ');
      if (spec.xmk && spec.xmk.length) res.understood += ' · no ' + spec.xmk.filter(function (m) { return m !== 'first_td' || spec.xmk.indexOf('anytime_td') < 0; }).filter(function (m) { return m !== 'two_plus_td' && m !== 'two_td' && (m !== 'three_td' || spec.xmk.indexOf('anytime_td') < 0); }).map(function (m) { return (MW[m] || m).toLowerCase(); }).join(', ');
      if (spec.no_props) res.understood += ' · no player props';
      res.base = chipBase(asked); res.chips = chips(asked);
      LAST = {q: q, spec: a[0].spec, legs: (res.rows || []).map(function (p) { return {name: p.name || p.label, play: p.label, price: p.price}; })};
      return res;
    });
  }
  window.OnyxAsk = {whenOk: whenOk, slotOk: slotOk, ask: ask, plusMinus: plusMinus, chips: chips, chipBase: chipBase, explain: explain, reset: reset, normalize: normalize, localSpec: localSpec, run: run, describe: describe, loadBoards: loadBoards, LG: LG, PAGE: PAGE, MKTS: MKTS};
})();
