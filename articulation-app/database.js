const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'articulation.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let db = null;

// ============ Async Database Initialization ============
async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // ============ Create Schema ============
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('learner','doctor')),
      password_hash TEXT,
      is_verified INTEGER DEFAULT 0,
      otp TEXT,
      otp_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS learner_doctor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      assigned_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (learner_id) REFERENCES users(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id),
      UNIQUE(learner_id, doctor_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sound_id TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      symbol TEXT NOT NULL,
      category TEXT NOT NULL,
      voicing TEXT NOT NULL,
      description TEXT,
      tongue TEXT,
      lips TEXT,
      jaw TEXT,
      airflow TEXT,
      tip TEXT,
      tongue_target TEXT,
      words_json TEXT,
      sentences_json TEXT,
      video_targets_json TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS practice_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sound_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('sound','word','sentence')),
      score INTEGER NOT NULL,
      transcript TEXT,
      target_text TEXT,
      mouth_shape_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS video_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      sound_id TEXT,
      level TEXT,
      video_path TEXT NOT NULL,
      notes TEXT,
      score INTEGER,
      target_text TEXT,
      doctor_feedback TEXT,
      doctor_rating INTEGER,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','reviewed','feedback_given')),
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT,
      analysis_json TEXT,
      FOREIGN KEY (learner_id) REFERENCES users(id),
      FOREIGN KEY (doctor_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS learner_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sound_id TEXT NOT NULL,
      unlocked_word INTEGER DEFAULT 0,
      unlocked_sentence INTEGER DEFAULT 0,
      word_idx INTEGER DEFAULT 0,
      sentence_idx INTEGER DEFAULT 0,
      sessions INTEGER DEFAULT 0,
      minutes INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      threshold INTEGER DEFAULT 80,
      last_practice_at TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, sound_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      language TEXT DEFAULT 'en',
      consent_recording INTEGER DEFAULT 0,
      consent_camera INTEGER DEFAULT 0,
      privacy_mode TEXT DEFAULT 'emoji',
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS assigned_sounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sound_id TEXT NOT NULL,
      assigned_by INTEGER,
      assigned_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_by) REFERENCES users(id),
      UNIQUE(user_id, sound_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS doctor_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL,
      learner_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (doctor_id) REFERENCES users(id),
      FOREIGN KEY (learner_id) REFERENCES users(id)
    )
  `);

  // Create indexes (ignore if already exist)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_attempts_user ON practice_attempts(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_attempts_sound ON practice_attempts(sound_id)',
    'CREATE INDEX IF NOT EXISTS idx_video_learner ON video_submissions(learner_id)',
    'CREATE INDEX IF NOT EXISTS idx_video_doctor ON video_submissions(doctor_id)',
    'CREATE INDEX IF NOT EXISTS idx_progress_user ON learner_progress(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_assigned_user ON assigned_sounds(user_id)',
  ];
  indexes.forEach(sql => { try { db.run(sql); } catch(e) {} });

  // ============ Seed Sounds ============
  seedSounds();

  // Save to disk
  saveDatabase();

  console.log('✅ Database initialized');
  return db;
}

// ============ Save database to disk ============
function saveDatabase() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Failed to save database:', e.message);
  }
}

// Auto-save every 30 seconds
setInterval(() => { if (db) saveDatabase(); }, 30000);

// ============ Helper: query wrappers (mimics better-sqlite3 API) ============
function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const result = stmt.getAsObject();
      stmt.free();
      return result;
    }
    stmt.free();
    return undefined;
  } catch (e) {
    console.error('dbGet error:', e.message, sql);
    return undefined;
  }
}

function dbAll(sql, params = []) {
  try {
    const results = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    console.error('dbAll error:', e.message, sql);
    return [];
  }
}

function dbRun(sql, params = []) {
  try {
    db.run(sql, params);
    return { changes: db.getRowsModified(), lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] || 0 };
  } catch (e) {
    console.error('dbRun error:', e.message, sql);
    return { changes: 0, lastInsertRowid: 0 };
  }
}

// ============ DEFAULT SOUNDS DATA ============
const DEFAULT_SOUNDS = [
  { id:'r', label:'R', symbol:'/r/', category:'Liquids', voicing:'Voiced',
    description:"The R sound is made by pulling the tongue tip up and back without touching the roof of the mouth, while the sides of the tongue touch the back upper teeth.",
    tongue:"Tongue tip curls up and back, not touching the palate ('bunched' or 'retroflex').",
    lips:"Lips are slightly rounded and pushed forward.",
    jaw:"Jaw is slightly closed, close to a neutral position.",
    airflow:"Air flows over the center of the tongue and out through a narrow channel.",
    tip:"Try gently pulling the tip of your tongue back without letting it touch the roof of your mouth, and round your lips a little.",
    tongueTarget:"translate(-8px,-14px) rotate(-8deg)",
    words:{ initial:['Red','Rabbit','Rain','Ring','Rope','Rose','Road','Rat','Run','Rest'], medial:['Cherry','Arrow','Carrot','Parrot','Mirror','Orange','Forest','Very','Berry','Story'], final:['Car','Star','Door','Four','Tiger','Water','Father','Mother','Teacher','Better'] },
    sentences:["The red rabbit is running.", "Robots race around the road.", "Rachel ran really fast to reach the rainbow.", "The robber ran around the river and the rocks.", "Robert rides his red bicycle really rapidly."],
    videoTargets:{ aperture:[25,58], width:[20,55], visible:'medium opening with slightly rounded lips',
      ifClosed:'Open the jaw a little while keeping the lips rounded.', ifWide:'Try rounding the lips instead of spreading them wide.', ifNarrow:'Keep the lips rounded but not tightly closed.' }},
  { id:'l', label:'L', symbol:'/l/', category:'Liquids', voicing:'Voiced',
    description:"The L sound is made by touching the tip of the tongue to the bumpy ridge just behind the upper front teeth, while air flows around the sides.",
    tongue:"Tongue tip presses the alveolar ridge (behind the top front teeth); tongue sides stay low.",
    lips:"Lips are relaxed and slightly open.",
    jaw:"Jaw drops a small, comfortable amount.",
    airflow:"Air flows around both sides of the tongue.",
    tip:"Tap the very tip of your tongue right behind your top front teeth, keeping the sides low so air can escape.",
    tongueTarget:"translate(10px,-16px) rotate(4deg)",
    words:{ initial:['Lion','Lemon','Lamp','Lake','Leaf','Lip','Lock','Leg','Log','Love'], medial:['Balloon','Yellow','Pillow','Jelly','Ballet','Hill','Color','Slowly','Apple','Table'], final:['Ball','Bell','Bottle','Castle','Girl','Pencil','Apple','Little','Animal','Metal'] },
    sentences:["Lily likes yellow balloons.", "The lion leaped over the log.", "Larry loves listening to loud laughter.", "The little ladybug landed on the large leaf.", "Look at the lovely lollipop and the lemon lamp."],
    videoTargets:{ aperture:[35,72], width:[35,78], visible:'comfortable opening with relaxed lips',
      ifClosed:'Open your mouth a little more so the tongue tip can lift behind the top teeth.', ifWide:'Relax the lips; the key movement is the tongue tip lifting.', ifNarrow:'Relax the lips and let air pass around the tongue sides.' }},
  { id:'s', label:'S', symbol:'/s/', category:'Fricatives', voicing:'Voiceless',
    description:"The S sound is made by placing the tongue close to the ridge behind the upper teeth, forming a narrow groove for air to hiss through.",
    tongue:"Tongue forms a narrow central groove, close to (not touching) the alveolar ridge.",
    lips:"Lips are relaxed and slightly spread.",
    jaw:"Jaw is nearly closed.",
    airflow:"A steady, hissing stream of air passes over the groove in the tongue.",
    tip:"Bring your tongue close to the ridge behind your top teeth without touching it, and let a thin stream of air hiss through.",
    tongueTarget:"translate(6px,-18px) rotate(2deg)",
    words:{ initial:['Sun','Soap','Sock','Soup','Sand','Sign','Six','Sit','Sick','Sing'], medial:['Pencil','Museum','Lesson','Person','Dinosaur','Rice','Castle','Dancing','Outside','Inside'], final:['Bus','Glass','Horse','House','Moose','Nurse','Voice','Class','Dress','Chess'] },
    sentences:["The sun shines on Sam's glass.", "Sara sees six soapy socks.", "Sam sat on the soft seat and sang a silly song.", "The silly snake slid slowly across the sandy shore.", "Sally sells silver seashells by the sunny seashore."],
    videoTargets:{ aperture:[12,45], width:[45,82], visible:'small opening with a slightly spread smile shape',
      ifClosed:'Leave a tiny opening for the hissing air stream.', ifWide:'Good spread — keep the jaw from opening too wide.', ifNarrow:'Spread the lips a little more, like a small smile.' }},
  { id:'sh', label:'SH', symbol:'/ʃ/', category:'Fricatives', voicing:'Voiceless',
    description:"The SH sound is made further back than S, with the tongue body domed and lips rounded and pushed slightly forward.",
    tongue:"Tongue body is raised and domed a little further back than for S.",
    lips:"Lips are rounded and pushed slightly forward.",
    jaw:"Jaw is slightly open.",
    airflow:"A broader, softer stream of air flows over the domed tongue.",
    tip:"Round your lips slightly and let the middle of your tongue rise toward the roof of your mouth, a bit further back than for 's'.",
    tongueTarget:"translate(-2px,-16px) rotate(-4deg)",
    words:{ initial:['Ship','Shoe','Shop','Shark','Shape','Shine','Shake','Shirt','Shell','Shut'], medial:['Washing','Cushion','Fishing','Pushing','Rushing','Nation','Motion','Ocean','Special','Patient'], final:['Fish','Wish','Dash','Bush','Brush','Finish','Furnish','Garnish','Lavish','Publish'] },
    sentences:["She sells sea shells.", "Wash the dishes, please.", "She should share her shiny shell with Shane.", "The shy sheep showed Sharon a short shiny ship.", "Sharon shopped for fresh shiny shoes at the shop."],
    videoTargets:{ aperture:[22,55], width:[18,58], visible:'medium-small opening with rounded lips',
      ifClosed:'Open slightly while keeping the lips rounded.', ifWide:'Round the lips more; avoid a wide smile shape.', ifNarrow:'Keep the lips rounded and gently forward.' }},
  { id:'ch', label:'CH', symbol:'/tʃ/', category:'Affricates', voicing:'Voiceless',
    description:"The CH sound starts as a brief full stop (like T) and releases into an SH-like hiss, all in one quick movement.",
    tongue:"Tongue tip briefly touches the ridge (stop), then releases into the SH tongue-body position.",
    lips:"Lips move from neutral to slightly rounded on release.",
    jaw:"Jaw opens slightly on release.",
    airflow:"Air is briefly stopped, then released in a short burst.",
    tip:"Start with your tongue tip touching the ridge behind your teeth, then release quickly into an 'sh' shape.",
    tongueTarget:"translate(2px,-15px) rotate(-2deg)",
    words:{ initial:['Chair','Cheese','Chick','Chain','Chalk','Change','Charge','Cheap','Check','Chess'], medial:['Teacher','Ketchup','Architect','Stomach','Lecture','Picture','Nature','Feature','Creature','Capture'], final:['Beach','Watch','Touch','Catch','Match','March','Search','Church','Teach','Couch'] },
    sentences:["The teacher watched the chair.", "Chad chose cheese and chips.", "Charlie chose to chase the cheerful chubby chipmunk.", "The cheerful children chatted and cheered at the church.", "Check if the charming chef changed the chocolate chips."],
    videoTargets:{ aperture:[25,62], width:[22,62], visible:'quick open release with slightly rounded lips',
      ifClosed:'Make a quick open release after the tongue-tip stop.', ifWide:'Round the lips a little on the release.', ifNarrow:'Release the sound with a little more jaw opening.' }},
  { id:'th', label:'TH', symbol:'/θ,ð/', category:'Interdental', voicing:'Both',
    description:"The TH sound is made by placing the tongue tip lightly between or behind the upper and lower front teeth.",
    tongue:"Tongue tip rests lightly between or just behind the front teeth.",
    lips:"Lips are relaxed and slightly parted.",
    jaw:"Jaw is slightly open to allow the tongue to reach the teeth.",
    airflow:"A gentle, continuous stream of air flows over the tongue tip.",
    tip:"Gently place the tip of your tongue between your front teeth and let a soft stream of air flow out.",
    tongueTarget:"translate(-20px,-6px) rotate(6deg)",
    words:{ initial:['This','Think','Three','Thumb','Thick','Thank','Theater','Therm','Thorn','Throne'], medial:['Feather','Bathroom','Nothing','Anything','Something','Together','Weather','Father','Mother','Brother'], final:['Teeth','Bath','Birth','Earth','Health','Math','Month','North','South','Youth'] },
    sentences:["This thumb is thin.", "The feather fell in the bath.", "I think that these things are worth thirty-three.", "Theo threw three thick things through the tunnel.", "Thank you for thinking about the other thirty thousand."],
    videoTargets:{ aperture:[35,75], width:[35,78], visible:'open mouth with relaxed lips for tongue-tip placement',
      ifClosed:'Open enough for the tongue tip to come forward between/behind the teeth.', ifWide:'Relax the lips; focus on gentle tongue-tip placement.', ifNarrow:'Relax the lips and keep a soft airflow.' }},
  { id:'k', label:'K', symbol:'/k/', category:'Stops', voicing:'Voiceless',
    description:"The K sound is made by pressing the back of the tongue against the soft palate (velum), then releasing a burst of air.",
    tongue:"Back of tongue presses firmly against the soft palate, then releases quickly.",
    lips:"Lips are relaxed and slightly open.",
    jaw:"Jaw is slightly open.",
    airflow:"Air is completely blocked, then released in a sharp burst.",
    tip:"Press the back of your tongue against the roof of your mouth (far back), then let go with a small burst of air.",
    tongueTarget:"translate(-14px,-20px) rotate(-10deg)",
    words:{ initial:['Cat','Key','King','Cup','Car','Kitchen','Kite','Kid','Kick','Kiss'], medial:['Cookie','Monkey','Bacon','Ticket','Jacket','Pocket','Bucket','Blanket','Broccoli','Acorn'], final:['Book','Back','Duck','Black','Clock','Kick','Knock','Lock','Neck','Rock','Sick','Truck','Walk','Week','Work'] },
    sentences:["The cat caught the key.", "Kate likes cookies and cake.", "Kevin kept the kite in the cool kitchen cabinet.", "The king kicked the colorful ball across the court.", "Can you come to the kitchen and cook some cookies?"],
    videoTargets:{ aperture:[28,60], width:[22,60], visible:'medium opening with relaxed lips',
      ifClosed:'Open your mouth slightly for the burst of air.', ifWide:'Keep lips relaxed, not spread.', ifNarrow:'Allow enough opening for the air release.' }},
  { id:'g', label:'G', symbol:'/g/', category:'Stops', voicing:'Voiced',
    description:"The G sound is made the same way as K, but with vocal cords vibrating — press the back of the tongue against the soft palate, then release.",
    tongue:"Back of tongue presses against the soft palate, same position as K.",
    lips:"Lips are relaxed and slightly open.",
    jaw:"Jaw is slightly open.",
    airflow:"Air is blocked, then released with vocal cord vibration.",
    tip:"Make the same tongue position as K, but add your voice — feel the vibration in your throat.",
    tongueTarget:"translate(-14px,-20px) rotate(-10deg)",
    words:{ initial:['Go','Game','Girl','Give','Get','Gate','Gift','Gold','Good','Green'], medial:['Tiger','Eagle','Sugar','Bigger','Together','Foggy','Angry','Jungle','Tugboat','Finger'], final:['Dog','Egg','Bag','Big','Bug','Dig','Fog','Hug','Jug','Log','Pig','Rug','Tag','Wig','Fig'] },
    sentences:["The girl gave the dog a hug.", "Greg goes to the garden.", "Gary gave Grace a gorgeous golden gift.", "The big green frog jumped over the foggy log.", "Go get the giggle ball and give it to Grace."],
    videoTargets:{ aperture:[28,60], width:[22,60], visible:'medium opening with relaxed lips, slight vibration',
      ifClosed:'Open slightly while adding voice.', ifWide:'Keep lips relaxed.', ifNarrow:'Relax the jaw a little more.' }},
  { id:'f', label:'F', symbol:'/f/', category:'Fricatives', voicing:'Voiceless',
    description:"The F sound is made by gently pressing the upper teeth against the lower lip and letting air flow through the gap.",
    tongue:"Tongue rests in a relaxed, low position.",
    lips:"Upper teeth gently touch the lower lip.",
    jaw:"Jaw is slightly open.",
    airflow:"A steady stream of air pushes through the gap between upper teeth and lower lip.",
    tip:"Bite your lower lip gently with your upper teeth and blow a steady stream of air.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Fish','Fan','Fox','Fun','Farm','Foot','Five','Find','Feel','Fill'], medial:['Coffee','Elephant','Waffle','Dolphin','Giraffe','Referee','Perfect','Comfort','Difficult','Telephone'], final:['Leaf','Off','Roof','Beef','Brief','Chief','Cough','Half','Knife','Loaf','Proof','Safe','Self','Wolf','Scarfe'] },
    sentences:["The fish swam fast.", "Find four fluffy feathers.", "Frank found five funny frogs in the forest.", "The fierce firefly flew far over the flowering field.", "Fiona finished her food and felt fantastic afterward."],
    videoTargets:{ aperture:[15,45], width:[30,65], visible:'small opening with upper teeth on lower lip',
      ifClosed:'Part the lips enough to show the teeth-on-lip contact.', ifWide:'Keep the contact between upper teeth and lower lip.', ifNarrow:'Relax the lips; the key is the teeth-lip contact.' }},
  { id:'v', label:'V', symbol:'/v/', category:'Fricatives', voicing:'Voiced',
    description:"The V sound is made exactly like F, but with the voice turned on — upper teeth on lower lip, air flowing through.",
    tongue:"Tongue rests in a relaxed, low position.",
    lips:"Upper teeth gently touch the lower lip.",
    jaw:"Jaw is slightly open.",
    airflow:"A steady stream of voiced air pushes through the gap between upper teeth and lower lip.",
    tip:"Same as F — upper teeth on lower lip — but turn on your voice and feel the vibration.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Van','Voice','Vase','View','Visit','Very','Valley','Vine','Vet','Vest'], medial:['Over','River','Oven','Diver','Cave','Drive','Eleven','Seven','Moving','Saving'], final:['Five','Give','Love','Above','Brave','Curve','Drive','Eleven','Groove','Halve','Leave','Live','Move','Serve','Wave'] },
    sentences:["The van drove over the river.", "Vera loves velvet vests.", "Victor and Violet visited the vivid valley.", "Steve gave eleven vivid violet flowers to Vivian.", "The clever dove lived above the active volcano."],
    videoTargets:{ aperture:[15,45], width:[30,65], visible:'small opening with upper teeth on lower lip, vibrating',
      ifClosed:'Part lips enough for teeth-lip contact.', ifWide:'Keep teeth gently on lower lip.', ifNarrow:'Relax the lips slightly.' }},
  { id:'p', label:'P', symbol:'/p/', category:'Stops', voicing:'Voiceless',
    description:"The P sound is made by pressing both lips firmly together, then releasing a burst of air.",
    tongue:"Tongue rests in a neutral position.",
    lips:"Lips press firmly together, then pop open.",
    jaw:"Jaw is nearly closed.",
    airflow:"Air builds up behind closed lips, then releases in a burst.",
    tip:"Press your lips tightly together, build up a little air pressure, then pop them open.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Pen','Pig','Park','Peach','Pie','Pool','Pot','Put','Push','Puppy'], medial:['Paper','Happy','Apple','Pepper','Cupcake','Maple','Open','Puppet','Report','Support'], final:['Map','Jump','Stop','Cap','Cup','Drop','Heap','Hip','Lamp','Loop','Mop','Pop','Rope','Ship','Step','Tap','Trip','Wrap'] },
    sentences:["Peter picked a pepper.", "Put the pig in the pen.", "Pamela put the purple paper on the pink pillow.", "Please put the pretty puppets in the proper place.", "The puppy played and pounced on the purple pillow."],
    videoTargets:{ aperture:[8,35], width:[20,55], visible:'lips pressed together, then pop open',
      ifClosed:'Pop the lips open more clearly.', ifWide:'Keep the lips pressing together before releasing.', ifNarrow:'Make the lip press more noticeable.' }},
  { id:'b', label:'B', symbol:'/b/', category:'Stops', voicing:'Voiced',
    description:"The B sound is made exactly like P, but with the voice turned on — lips press together, then release with vibration.",
    tongue:"Tongue rests in a neutral position.",
    lips:"Lips press firmly together, then pop open with voice.",
    jaw:"Jaw is nearly closed.",
    airflow:"Air builds up behind closed lips, then releases with vocal cord vibration.",
    tip:"Same as P — press your lips together and pop them open — but add your voice this time.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Ball','Boy','Bed','Bus','Big','Bear','Blue','Box','But','Bird'], medial:['Baby','Rabbit','Bubble','Cabbage','Lobby','Hobby','Cabin','Tabby','Ribbon','Subway'], final:['Job','Tub','Cub','Club','Crab','Grab','Knob','Lob','Prob','Rob','Stab','Web'] },
    sentences:["The boy bounced the ball.", "Betty bought a blue blanket.", "The big brown bear blew bubbles by the blue barn.", "Barbara baked banana bread for her baby brother.", "Bobby brought his big blue ball to the birthday party."],
    videoTargets:{ aperture:[8,35], width:[20,55], visible:'lips pressed together, then pop open with vibration',
      ifClosed:'Pop lips open more clearly.', ifWide:'Keep lips together before releasing.', ifNarrow:'Make the lip press more noticeable.' }},
  { id:'t', label:'T', symbol:'/t/', category:'Stops', voicing:'Voiceless',
    description:"The T sound is made by pressing the tongue tip firmly against the ridge behind the upper teeth, then releasing a burst of air.",
    tongue:"Tongue tip presses firmly against the alveolar ridge, then releases.",
    lips:"Lips are relaxed and slightly open.",
    jaw:"Jaw is slightly open.",
    airflow:"Air is blocked completely, then released in a sharp burst.",
    tip:"Press the tip of your tongue right behind your top teeth and release with a small pop of air.",
    tongueTarget:"translate(10px,-18px) rotate(4deg)",
    words:{ initial:['Top','Tiger','Tree','Table','Talk','Tall','Tea','Ten','Time','Tiny'], medial:['Water','Butter','Letter','Button','Cotton','Bottle','Kitten','Matter','Pattern','Better'], final:['Cat','Hat','Boat','Belt','Bit','Boot','Coat','Cut','Feet','Foot','Gift','Goat','Hot','Late','Meat','Note','Paint','Seat','Sweet','Wait'] },
    sentences:["Tom took two towels.", "The turtle went to the top.", "Tina told Tim to take the tiny turtle to the table.", "The tall teacher taught twelve students to tie their ties.", "Trent tried to tell the terrible tiger to turn around."],
    videoTargets:{ aperture:[15,48], width:[25,60], visible:'slight opening with quick tongue release',
      ifClosed:'Open slightly for the air burst.', ifWide:'Keep lips relaxed, not spread.', ifNarrow:'Allow enough opening for the release.' }},
  { id:'d', label:'D', symbol:'/d/', category:'Stops', voicing:'Voiced',
    description:"The D sound is made exactly like T, but with the voice turned on — tongue tip on the ridge, then release with vibration.",
    tongue:"Tongue tip presses against the alveolar ridge, same as T.",
    lips:"Lips are relaxed and slightly open.",
    jaw:"Jaw is slightly open.",
    airflow:"Air is blocked, then released with vocal cord vibration.",
    tip:"Same as T — tongue tip behind top teeth — but turn on your voice.",
    tongueTarget:"translate(10px,-18px) rotate(4deg)",
    words:{ initial:['Dog','Door','Duck','Dad','Dance','Dark','Day','Deep','Dirt','Done'], medial:['Ladder','Window','Puddle','Candle','Middle','Puddle','Riddle','Shadow','Teddy','Wedding'], final:['Bed','Red','Sad','Add','Bad','Bird','Child','Cloud','Cold','End','Food','Good','Hand','Hard','Head','Hold','Kind','Land','Load','Road','Sand','Stand','Wood','World'] },
    sentences:["Dan did a dance.", "The dog dug a deep den.", "David and Diana danced down the dusty dirt road.", "The delighted duck dived deep into the dark pond.", "Donna decided to decorate her den with red diamonds."],
    videoTargets:{ aperture:[15,48], width:[25,60], visible:'slight opening with voiced tongue release',
      ifClosed:'Open slightly for the voiced burst.', ifWide:'Keep lips relaxed.', ifNarrow:'Allow enough opening.' }},
  { id:'n', label:'N', symbol:'/n/', category:'Nasals', voicing:'Voiced',
    description:"The N sound is made by pressing the tongue tip against the ridge behind the upper teeth while air flows out through the nose.",
    tongue:"Tongue tip presses against the alveolar ridge.",
    lips:"Lips are relaxed and together or slightly apart.",
    jaw:"Jaw is slightly open.",
    airflow:"Air flows out through the nose while the mouth is blocked.",
    tip:"Press your tongue tip behind your top teeth and hum — the air should come out of your nose.",
    tongueTarget:"translate(10px,-18px) rotate(4deg)",
    words:{ initial:['Net','Nose','Nest','Name','Nap','Near','Need','Next','Nice','Night','Nine','No','Not','Now','Number'], medial:['Banana','Penny','Lion','Dinner','Funnel','Honey','Lemon','Mane','Runner','Sunset','Tennis','Under','Winner','Zombie','Dinner'], final:['Sun','Pen','Fan','Bean','Brain','Clean','Corn','Fun','Green','Jan','Lane','Lean','Man','Mean','Moon','Pan','Plain','Rain','Run','Seen','Skin','Spin','Ten','Thin','Town','Turn','Van','Win','Zone'] },
    sentences:["Nine new notebooks.", "Nina found a nice nest.", "Nancy noticed nine new neighbors near the narrow lane.", "The nanny named Nina knitted a nice warm blanket.", "Ned and Nora never needed new notebooks in November."],
    videoTargets:{ aperture:[10,40], width:[25,60], visible:'lips gently closed or slightly open, humming',
      ifClosed:'Keep a gentle, relaxed closure.', ifWide:'Relax the lips.', ifNarrow:'Keep lips gently together.' }},
  { id:'m', label:'M', symbol:'/m/', category:'Nasals', voicing:'Voiced',
    description:"The M sound is made by pressing both lips together while air flows out through the nose.",
    tongue:"Tongue rests in a neutral position.",
    lips:"Lips are pressed gently together.",
    jaw:"Jaw is nearly closed.",
    airflow:"Air flows out entirely through the nose.",
    tip:"Close your lips gently and hum — feel the buzz in your nose.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Moon','Mouse','Map','Man','Many','Milk','Mix','More','Most','Move','Much','Must','My'], medial:['Lemon','Hammer','Tomato','Camel','Diamond','Emerald','Family','Humming','Lumber','Number','Puma','Ramen','Summer','Summer','Tummy','Warmth'], final:['Home','Room','Game','Arm','Bloom','Claim','Cream','Dream','Drum','Farm','Film','Flame','Form','From','Gum','Him','Jam','Limb','Name','Plum','Ram','Rim','Sam','Scam','Slam','Slim','Some','Storm','Sum','Swim','Team','Time','Tom','Warm','Whom','Yam','Zoom'] },
    sentences:["My mom made muffins.", "The mouse ran to the moon.", "Molly made many marvelous mosaics in the morning.", "The mighty moose marched to the meadow near the mountain.", "Marcus met his mom at the mall and made a map."],
    videoTargets:{ aperture:[5,30], width:[18,50], visible:'lips gently closed, humming expression',
      ifClosed:'Keep lips gently together.', ifWide:'Close the lips more gently.', ifNarrow:'Gently close lips for humming.' }},
  { id:'w', label:'W', symbol:'/w/', category:'Glides', voicing:'Voiced',
    description:"The W sound is made by rounding the lips tightly and raising the back of the tongue, then quickly moving to the next vowel.",
    tongue:"Back of tongue is raised high, similar to a 'u' vowel position.",
    lips:"Lips are tightly rounded and pushed forward.",
    jaw:"Jaw is nearly closed.",
    airflow:"Air flows out as the lips and tongue quickly transition.",
    tip:"Round your lips tightly like you're about to whistle, then quickly open to the next sound.",
    tongueTarget:"translate(-10px,-12px) rotate(-6deg)",
    words:{ initial:['Water','Window','Whale','Walk','Wall','Want','War','Warm','Wash','Watch','Wave','Way','Week','Well','West','Wet','What','When','Where','Which','While','White','Who','Why','Wide','Wild','Will','Win','Wind','Wing','Winter','Wire','Wise','With','Without','Woman','Wonder','Wood','Word','Work','World','Worry','Worse','Worst','Worth','Would','Wrap','Write','Wrong'], medial:['Away','Flower','Sandwich','Backward','Bowling','Cowboy','Dwarf','Homework','Onward','Reward','Sideways','Upward'], final:['Snow','Bow','New','Blow','Chew','Claw','Crew','Draw','Few','Flew','Flow','Glow','Grow','Haw','Jaw','Knew','Law','Low','Mow','Now','Paw','Raw','Row','Saw','Show','Slow','Stow','Straw','Thaw','Throw','Tow','View','Widow'] },
    sentences:["We went walking in the woods.", "Will was washing the white wall.", "Wendy went to the wonderful winter waterfall.", "We will wait and watch the wild white wolf.", "William was worried when the weather was wet and windy."],
    videoTargets:{ aperture:[15,40], width:[15,45], visible:'tightly rounded lips',
      ifClosed:'Round the lips more tightly.', ifWide:'Tighten the lip rounding.', ifNarrow:'Push the lips forward more.' }},
  { id:'y', label:'Y', symbol:'/j/', category:'Glides', voicing:'Voiced',
    description:"The Y sound is made by raising the middle of the tongue close to the roof of the mouth, similar to a long 'e' position, then gliding into the next vowel.",
    tongue:"Middle of tongue is raised high, close to the palate.",
    lips:"Lips are spread slightly, like a smile.",
    jaw:"Jaw is slightly open.",
    airflow:"Air flows smoothly as the tongue glides from the high position.",
    tip:"Start with your tongue in a 'ee' position, then glide into the next vowel sound.",
    tongueTarget:"translate(-4px,-20px) rotate(-3deg)",
    words:{ initial:['Yes','Yellow','Yarn','Yak','Yam','Yard','Year','Yell','Yesterday','Yet','Yoga','You','Young','Your','Youth'], medial:['Onion','Canyon','Banyan','Beyond','Buyer','Crayon','Layer','Mayor','Player','Royal','Saying','Staying'], final:['Boy','Toy','Enjoy','Alloy','Annoy','Convoy','Decoy','Deploy','Destroy','Employ','Joy','Oyster','Valley'] },
    sentences:["Yes, you may yell.", "The yellow yak yawned yesterday.", "The young yodeler yelled from the yard yesterday.", "Yesterday your yellow yacht yielded many young fish.", "Yolanda and Yuri yarned year round in the yard."],
    videoTargets:{ aperture:[18,48], width:[30,65], visible:'slightly spread lips, relaxed opening',
      ifClosed:'Open a little more for the glide.', ifWide:'Keep a gentle spread.', ifNarrow:'Spread the lips slightly.' }},
  { id:'z', label:'Z', symbol:'/z/', category:'Fricatives', voicing:'Voiced',
    description:"The Z sound is made exactly like S, but with the voice turned on — tongue close to the ridge, a narrow groove for air, and vocal cords vibrating.",
    tongue:"Tongue forms a narrow central groove, close to the alveolar ridge.",
    lips:"Lips are relaxed and slightly spread.",
    jaw:"Jaw is nearly closed.",
    airflow:"A voiced, buzzing stream of air passes over the groove in the tongue.",
    tip:"Make the same shape as S, but turn on your voice — it should buzz like a bee.",
    tongueTarget:"translate(6px,-18px) rotate(2deg)",
    words:{ initial:['Zoo','Zero','Zip','Zap','Zeal','Zen','Zest','Zigzag','Zinc','Zone','Zoom'], medial:['Pizza','Desert','Music','Amazing','Buzzer','Citizen','Dizzy','Fuzzy','Gazelle','Hazard','Puzzle','Quiz','Raisin','Sneeze','Wizzard'], final:['Buzz','Fuzz','Jazz','Blaze','Breeze','Cheese','Choose','Daze','Eyes','Freeze','Furze','Gaze','Glaze','Graze','Haze','Laze','Phase','Phrase','Please','Prize','Rise','Sneeze','Trose','Was','Wise'] },
    sentences:["The zebra went to the zoo.", "Buzz and fizz all day.", "The zigzagging zebra zoomed past the zinnias.", "Zachary zipped his zigzag jacket at the zoo.", "The zesty zinnias made the zen garden look amazing."],
    videoTargets:{ aperture:[12,45], width:[45,82], visible:'small opening with slightly spread lips, buzzing',
      ifClosed:'Leave a tiny opening for the buzzing air.', ifWide:'Keep the jaw from opening too wide.', ifNarrow:'Spread the lips a little more.' }},
  { id:'h', label:'H', symbol:'/h/', category:'Fricatives', voicing:'Voiceless',
    description:"The H sound is made by a gentle flow of air from the throat through the open mouth — no tongue or lip contact needed.",
    tongue:"Tongue is in a relaxed, neutral position.",
    lips:"Lips are open and relaxed, shaped for the following vowel.",
    jaw:"Jaw is slightly open.",
    airflow:"A gentle stream of air flows from the vocal cords through the open mouth.",
    tip:"Breathe out gently through your mouth — it's like a quiet sigh shaped by the next vowel.",
    tongueTarget:"translate(0,0) rotate(0deg)",
    words:{ initial:['Hat','House','Hand','Hair','Half','Hall','Ham','Hang','Happy','Hard','Hate','Have','He','Head','Heart','Heat','Heavy','Help','Her','Here','Hero','High','Hill','Him','Hip','His','Hit','Hold','Hole','Home','Honey','Hope','Horn','Horse','Hot','Hour','How','Huge','Hungry','Hunt','Hurry','Hurt'], medial:['Behind','Rehearse','Vehicle','Ahead','Behave','Exhibit','Inherit','Perhaps','Somehow','Unhappy','Anywhere','Everybody','Everything','Nowhere','Somehow'], final:['Uh','Ah','Bah','Yeah'] },
    sentences:["Hello, how are you?", "Hannah had a happy holiday.", "Harry the happy hippo hopped through the hills.", "Helen heard a hundred horses heading to the hills.", "Hank hoped his huge hammer would help hang the heavy hardware."],
    videoTargets:{ aperture:[30,65], width:[25,65], visible:'relaxed open mouth, gentle breathing',
      ifClosed:'Open the mouth slightly for the airflow.', ifWide:'Keep a relaxed opening.', ifNarrow:'Allow a gentle opening.' }},
];

function seedSounds() {
  const existing = dbGet('SELECT COUNT(*) as cnt FROM sounds');
  if (existing && existing.cnt > 0) {
    console.log(`   Sounds already seeded (${existing.cnt} sounds)`);
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO sounds (sound_id, label, symbol, category, voicing, description, tongue, lips, jaw, airflow, tip, tongue_target, words_json, sentences_json, video_targets_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  DEFAULT_SOUNDS.forEach((s, i) => {
    stmt.run([s.id, s.label, s.symbol, s.category, s.voicing, s.description, s.tongue, s.lips, s.jaw, s.airflow, s.tip, s.tongueTarget, JSON.stringify(s.words), JSON.stringify(s.sentences), JSON.stringify(s.videoTargets), i]);
  });
  stmt.free();

  saveDatabase();
  console.log(`✅ Seeded ${DEFAULT_SOUNDS.length} sounds into database`);
}

// ============ Exports ============
module.exports = { initDatabase, dbGet, dbAll, dbRun, saveDatabase };
