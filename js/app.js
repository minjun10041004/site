(() => {
  'use strict';

  /* ---------------- Local (device-level) storage — theme only ---------------- */
  const THEME_KEY = 'momentum_theme';
  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  /* ---------------- Supabase (accounts + cloud data) ---------------- */
  const SUPABASE_URL = 'https://mtjqnbmtyiqncococimb.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10anFuYm10eWlxbmNvY29jaW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyMTA0MzUsImV4cCI6MjEwMjc4NjQzNX0.w7xBKguv8ynXLOqNMMlJJf6ODnypwR-4a7hR_yztOcE';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const usernameToEmail = (username) => `${username.trim().toLowerCase()}@momentum.local`;

  let currentUserId = null;
  let currentUsername = null;

  let schedules = [];
  let todosByDate = {};
  let gold = 1000;
  let subjects = [];
  let studyByDate = {};
  let activeSession = null;
  let realmLevel = 0;
  let swordLevel = 0;      // index of the equipped sword in SWORDS
  let discovered = [0];    // sword indices ever drawn (도감 unlock state)

  /* Bumped whenever the sword table is reshaped, so stale sword indices
     from an older layout can't silently point at the wrong blade. */
  const SWORD_TABLE_VERSION = 2;

  function collectState() {
    return {
      schedules, todosByDate, gold, subjects, studyByDate, activeSession,
      realmLevel, swordLevel, discovered, swordTableVersion: SWORD_TABLE_VERSION,
    };
  }

  function applyState(data) {
    schedules = data.schedules ?? [];
    todosByDate = data.todosByDate ?? {};
    gold = data.gold ?? 1000;
    subjects = data.subjects ?? [];
    studyByDate = data.studyByDate ?? {};
    activeSession = data.activeSession ?? null;
    realmLevel = data.realmLevel ?? 0;

    if (data.swordTableVersion === SWORD_TABLE_VERSION) {
      swordLevel = data.swordLevel ?? 0;
      discovered = Array.isArray(data.discovered) && data.discovered.length ? data.discovered : [0];
    } else {
      // Pre-gacha save: the old index meant a rung on a different ladder.
      swordLevel = 0;
      discovered = [0];
    }
    swordLevel = Math.min(Math.max(swordLevel, 0), SWORDS.length - 1);
    discovered = [...new Set(discovered.filter((i) => i >= 0 && i < SWORDS.length))];
    if (!discovered.includes(swordLevel)) discovered.push(swordLevel);
  }

  function sumStudySecondsForDate(dateKey) {
    const day = studyByDate[dateKey];
    if (!day) return 0;
    return Object.values(day).reduce((a, b) => a + b, 0);
  }

  function sumStudySecondsRolling(days) {
    let total = 0;
    const todayK = todayKey();
    for (let i = 0; i < days; i++) total += sumStudySecondsForDate(addDays(todayK, -i));
    return total;
  }

  async function flushSave() {
    if (!currentUserId) return;
    await Promise.all([
      sb.from('app_data').upsert({
        user_id: currentUserId,
        data: collectState(),
        updated_at: new Date().toISOString(),
      }),
      sb.from('leaderboard').upsert({
        user_id: currentUserId,
        username: currentUsername,
        realm_level: realmLevel,
        sword_level: swordLevel,
        gold,
        study_today: sumStudySecondsForDate(todayKey()),
        study_week: sumStudySecondsRolling(7),
        study_month: sumStudySecondsRolling(30),
        updated_at: new Date().toISOString(),
      }),
    ]);
  }

  let saveTimer = null;
  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }
  window.addEventListener('beforeunload', () => {
    if (saveTimer) flushSave();
  });

  async function loadUserState() {
    const { data } = await sb.from('app_data').select('data').eq('user_id', currentUserId).maybeSingle();
    if (data && data.data) {
      applyState(data.data);
    } else {
      applyState({});
      await flushSave();
    }
  }

  /* ---------------- Date helpers ---------------- */
  const toKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const startOfDay = (d) => {
    const nd = new Date(d);
    nd.setHours(0, 0, 0, 0);
    return nd;
  };
  const todayKey = () => toKey(startOfDay(new Date()));
  const addDays = (key, n) => {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return toKey(dt);
  };
  const daysBetween = (fromKey, toKeyStr) => {
    const [y1, m1, d1] = fromKey.split('-').map(Number);
    const [y2, m2, d2] = toKeyStr.split('-').map(Number);
    const a = Date.UTC(y1, m1 - 1, d1);
    const b = Date.UTC(y2, m2 - 1, d2);
    return Math.round((b - a) / 86400000);
  };
  const formatHuman = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  };
  const formatShort = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return `${m}/${d}`;
  };

  /* ---------------- State ---------------- */
  let viewingDateKey = todayKey();

  /* ---------------- Elements ---------------- */
  const el = (id) => document.getElementById(id);

  const scheduleForm = el('scheduleForm');
  const scheduleTitleInput = el('scheduleTitle');
  const scheduleDateInput = el('scheduleDate');
  const scheduleList = el('scheduleList');
  const scheduleEmpty = el('scheduleEmpty');
  const scheduleBadge = el('scheduleBadge');
  const scheduleItemTpl = el('scheduleItemTemplate');

  const todoForm = el('todoForm');
  const todoTextInput = el('todoText');
  const todoList = el('todoList');
  const todoEmpty = el('todoEmpty');
  const todoItemTpl = el('todoItemTemplate');
  const viewingDateLabel = el('viewingDate');
  const prevDayBtn = el('prevDay');
  const nextDayBtn = el('nextDay');
  const jumpTodayBtn = el('jumpToday');

  const daySummaryFill = el('daySummaryFill');
  const daySummaryPercent = el('daySummaryPercent');

  const ringFg = el('ringFg');
  const ringPercent = el('ringPercent');
  const streakValue = el('streakValue');
  const upcomingCount = el('upcomingCount');
  const todoCount = el('todoCount');
  const todayDateEl = el('todayDate');
  const motivationQuote = el('motivationQuote');

  const heatmap = el('heatmap');
  const historyEmpty = el('historyEmpty');

  const themeSwitch = el('themeSwitch');

  const goldAmountEl = el('goldAmount');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    main: el('panel-main'),
    study: el('panel-study'),
    realm: el('panel-realm'),
    sword: el('panel-sword'),
    codex: el('panel-codex'),
    ranking: el('panel-ranking'),
    settings: el('panel-settings'),
  };

  const authGate = el('authGate');
  const authTabs = Array.from(document.querySelectorAll('.auth-tab'));
  const authForm = el('authForm');
  const authUsernameInput = el('authUsername');
  const authPasswordInput = el('authPassword');
  const authSubmitBtn = el('authSubmitBtn');
  const authError = el('authError');
  const settingsUsernameEl = el('settingsUsername');
  const logoutBtn = el('logoutBtn');

  const timerSubjectLabel = el('timerSubjectLabel');
  const timerDisplay = el('timerDisplay');
  const measureBtn = el('measureBtn');
  const timerHint = el('timerHint');
  const todayTotalDisplay = el('todayTotalDisplay');
  const subjectBadge = el('subjectBadge');
  const subjectList = el('subjectList');
  const subjectEmpty = el('subjectEmpty');
  const subjectForm = el('subjectForm');
  const subjectTextInput = el('subjectText');
  const subjectItemTpl = el('subjectItemTemplate');

  const ladderRowTpl = el('ladderRowTemplate');

  const myRankEl = el('myRank');
  const rankCategoryButtons = Array.from(document.querySelectorAll('.rank-cat-btn'));
  const rankList = el('rankList');
  const rankEmpty = el('rankEmpty');
  const rankRowTpl = el('rankRowTemplate');

  const toastEl = el('toast');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

  /* ---------------- Cultivation realm ladder (경지) — 나노마신 경지 분류 기반 ---------------- */
  const REALMS = [
    { name: '삼류무사', hanja: '三流武士', price: 0, studyBonus: 0,
      desc: '무공의 첫걸음을 뗀 초심자. 검을 쥐는 법조차 서투르지만, 모든 전설은 여기서 시작된다.' },
    { name: '이류무사', hanja: '二流武士', price: 28000, studyBonus: 40,
      desc: '어설프던 초식이 제법 날카로워졌다. 이제 겨우 무림의 문턱을 넘본다.' },
    { name: '일류무사', hanja: '一流武士', price: 36000, studyBonus: 50,
      desc: '정파 명문 문파의 후기지수들과 어깨를 견줄 만한 실력을 갖췄다.' },
    { name: '절정 초입', hanja: '絶頂 初入', price: 47000, studyBonus: 70,
      desc: '내공이 단전에 뿌리내리기 시작하며, 명문 대파의 제자로 인정받기 시작하는 경지.' },
    { name: '절정 완숙', hanja: '絶頂 完熟', price: 64000, studyBonus: 100,
      desc: '다루는 무공이 물 흐르듯 자연스러워지고, 한 지역을 대표하는 강자로 자리잡는다.' },
    { name: '절정 극', hanja: '絶頂 極', price: 86000, studyBonus: 130,
      desc: '절정의 끝자락. 이때부터는 어엿한 「고수」로 불리며, 문파나 가문의 수장을 넘보게 된다.' },
    { name: '초절정 초입', hanja: '超絶頂 初入', price: 120000, studyBonus: 180,
      desc: '구파일방과 천마신교의 장로 바로 아래 서열. 중원 전역에 이름이 알려지기 시작한다.' },
    { name: '초절정 완숙', hanja: '超絶頂 完熟', price: 169000, studyBonus: 240,
      desc: '문주, 가주, 방주, 채주급의 실력. 단신으로 수십의 일류 고수를 상대할 수 있다.' },
    { name: '초절정 극', hanja: '超絶頂 極', price: 238000, studyBonus: 320,
      desc: '초절정의 정점. 「초고수」라 불리며, 대문파의 장로 자리를 넘보는 실력자.' },
    { name: '화경 초입', hanja: '化境 初入', price: 339000, studyBonus: 430,
      desc: '몸과 진기가 하나로 화(化)하기 시작하며, 어검(馭劍)의 실마리를 잡는 경지.' },
    { name: '화경 완숙', hanja: '化境 完熟', price: 486000, studyBonus: 580,
      desc: '천마신교 좌우 호법, 구파일방 장문인급. 진기만으로 병기를 부린다.' },
    { name: '화경 극', hanja: '化境 極', price: 697000, studyBonus: 770,
      desc: '화경의 정점. 삼대 세력 수뇌부와 어깨를 나란히 하는, 사실상 무림 최정상.' },
    { name: '현경 초입', hanja: '炫境 初入', price: 995000, studyBonus: 1000,
      desc: '생각이 곧 진기가 되어 눈부시게(炫) 빛나는 경지. 살아서는 닿기 힘들다는 벽 너머.' },
    { name: '현경 완숙', hanja: '炫境 完熟', price: 1400000, studyBonus: 1400,
      desc: '이기어검을 자유자재로 다루며, 존재 자체가 눈부신 빛으로 화한다.' },
    { name: '현경 극', hanja: '炫境 極', price: 2100000, studyBonus: 1900,
      desc: '현경의 끝. 전설로만 회자되던 경지에 실제로 도달한 극소수의 존재.' },
    { name: '생사경 초입', hanja: '生死境 初入', price: 3000000, studyBonus: 2500,
      desc: '삶과 죽음의 경계를 손끝으로 다루기 시작하는, 죽어야만 넘볼 수 있다던 금단의 영역.' },
    { name: '생사경 완숙', hanja: '生死境 完熟', price: 4400000, studyBonus: 3400,
      desc: '생과 사가 손안에서 하나가 된다. 존재만으로도 강호에 죽음의 그림자를 드리운다.' },
    { name: '생사경 극', hanja: '生死境 極', price: 6500000, studyBonus: 4600,
      desc: '생사경의 정점. 산 자의 몸으로 죽음 너머를 완전히 지배하는, 전설 속 인물의 경지.' },
    { name: '자연경 초입', hanja: '自然境 初入', price: 9400000, studyBonus: 6200,
      desc: '불로불사에 이르러 자연과 동화되기 시작하는, 인간의 굴레를 벗어난 신비의 경지.' },
    { name: '자연경 완숙', hanja: '自然境 完熟', price: 13700000, studyBonus: 8300,
      desc: '천지의 기운과 완전히 하나가 되어, 늙지도 죽지도 않는 존재로 거듭난다.' },
    { name: '자연경 극', hanja: '自然境 極', price: 20000000, studyBonus: 11000,
      desc: '자연경의 정점. 스스로가 곧 자연의 일부가 되어, 더는 「인간」이라 부를 수 없는 존재.' },
    { name: '공허경 초입', hanja: '空虛境 初入', price: 29100000, studyBonus: 15000,
      desc: '우주의 이치를 어렴풋이 깨닫기 시작하는, 공(空)과 허(虛)의 경계에 선 경지.' },
    { name: '공허경 완숙', hanja: '空虛境 完熟', price: 42400000, studyBonus: 20000,
      desc: '우주의 지혜가 온전히 몸에 스며들어, 만물의 근원을 손바닥 위에 놓고 본다.' },
    { name: '공허경 극', hanja: '空虛境 極', price: 61900000, studyBonus: 27000,
      desc: '공허경의 정점. 텅 빈 듯하나 만물을 품은, 언어로는 형용할 수 없는 미지의 영역.' },
    { name: '여의경 초입', hanja: '如意境 初入', price: 90700000, studyBonus: 37000,
      desc: '뜻하는 대로 만물이 응하기 시작하는, 그 누구도 이르지 못했던 미지의 첫걸음.' },
    { name: '여의경 완숙', hanja: '如意境 完熟', price: 132000000, studyBonus: 49000,
      desc: '무한한 의지(意志) 그 자체가 되어, 이치와 조화를 자유로이 넘나든다.' },
    { name: '여의경 극', hanja: '如意境 極', price: 193000000, studyBonus: 66000,
      desc: '여의경의 정점이자 구도(求道)의 완성. 뜻이 곧 하늘이 되는, 더는 오를 곳이 없는 경지.' },
  ];

  /* ---------------- Sword rarities (검 등급) ----------------
     6 grades, probabilities fixed per grade — every sword inside a grade
     shares the exact same draw chance. Grade odds sum to 100. */
  const RARITIES = [
    { key: 'common',    name: '일반', hanja: '一般', chance: 50 },
    { key: 'uncommon',  name: '고급', hanja: '高級', chance: 28 },
    { key: 'rare',      name: '희귀', hanja: '稀貴', chance: 14 },
    { key: 'epic',      name: '영웅', hanja: '英雄', chance: 6 },
    { key: 'legendary', name: '전설', hanja: '傳說', chance: 1.8 },
    { key: 'mythic',    name: '신화', hanja: '神話', chance: 0.2 },
  ];

  /* ---------------- Sword pool (검 도감) ----------------
     Ordered weakest -> strongest, so a higher index is always the better
     blade. Within one grade the spread is kept inside 20%; between grades
     it is roughly 4x, so a grade-up dwarfs anything within a grade. */
  const SWORDS = [
    /* ---- 일반 ---- */
    { name: '목검', hanja: '木劍', rarity: 0, studyBonus: 200,
      lore: '무당 입문 제자가 처음 손에 쥐는 수련용 검. 스승은 이 검으로 삼 년을 휘두르게 한 뒤에야 진짜 검을 내어준다.',
      desc: '베는 검이 아니라 자세를 만드는 검. 모든 전설은 이 볼품없는 나무토막에서 시작된다.' },
    { name: '죽엽검', hanja: '竹葉劍', rarity: 0, studyBonus: 210,
      lore: '남만의 대숲에서 자란 백년 묵은 왕대를 결대로 갈라 만든 검. 촌부들이 산짐승을 쫓을 때 쓰던 물건이다.',
      desc: '나뭇잎처럼 가볍다. 위력은 보잘것없지만, 손목의 힘을 기르는 데는 이만한 것이 없다.' },
    { name: '철검', hanja: '鐵劍', rarity: 0, studyBonus: 215,
      lore: '저잣거리 대장간에서 은자 두 냥이면 살 수 있는 양산품. 강호에 발을 들인 자의 열에 아홉은 이 검을 찬다.',
      desc: '투박하고 무겁고 잘 부러진다. 그럼에도 첫 애병으로 이 검을 기억하는 무사는 수없이 많다.' },
    { name: '흑철검', hanja: '黑鐵劍', rarity: 0, studyBonus: 225,
      lore: '값싼 잡철에 그을음을 먹여 벼려낸 검은 칼날. 밤길에 빛을 반사하지 않아 뒷골목 무사들이 즐겨 찾았다.',
      desc: '어둠에 잘 녹아든다는 것 외에는 철검과 다를 바가 없다. 하지만 그 하나로 목숨을 건진 자가 적지 않다.' },
    { name: '청강검', hanja: '靑鋼劍', rarity: 0, studyBonus: 230,
      lore: '무쇠를 아홉 번 접어 두드린 청빛 강철검. 정파 문파에서 정식 제자에게 내리는 첫 하사품이다.',
      desc: '드디어 「부러지지 않는」 검을 손에 넣었다. 예기가 살아 있어 초식이 제법 그럴싸해 보인다.' },
    { name: '백은검', hanja: '白銀劍', rarity: 0, studyBonus: 240,
      lore: '검신에 은을 얇게 입혀 광택을 낸 명문 무기점의 수작. 실용보다 격식을 위한 검이었다.',
      desc: '햇빛을 받으면 눈부시게 빛난다. 상대가 눈을 찌푸리는 그 찰나가, 때로는 승부를 가른다.' },

    /* ---- 고급 ---- */
    { name: '유수검', hanja: '流水劍', rarity: 1, studyBonus: 850,
      lore: '강남 수로방(水路幇)의 비전 병기. 물길을 다스리던 장인이 흐르는 물의 결을 그대로 검신에 새겼다.',
      desc: '휘두르면 검로가 끊기지 않고 물처럼 이어진다. 막아도 막아도 다음 초식이 흘러들어온다.' },
    { name: '벽라검', hanja: '碧螺劍', rarity: 1, studyBonus: 880,
      lore: '동정호 깊은 곳에서 건져 올린 벽라석(碧螺石)을 녹여 섞은 검. 검신에 소라 무늬 물결이 감돈다.',
      desc: '푸른 빛이 은은히 감돌아 상대의 시선을 흐트러뜨린다. 실력보다 기세로 먼저 이기는 검.' },
    { name: '파풍검', hanja: '破風劍', rarity: 1, studyBonus: 920,
      lore: '쾌검으로 이름 높던 풍운장(風雲莊)의 상징. 검신에 뚫린 세 개의 홈이 바람을 가르며 울음소리를 낸다.',
      desc: '휘두르는 소리가 상대의 귀에 닿았을 때는 이미 늦었다. 속도만으로 한 시대를 풍미한 검.' },
    { name: '한빙검', hanja: '寒氷劍', rarity: 1, studyBonus: 950,
      lore: '북해빙궁(北海氷宮)의 만년한옥(萬年寒玉)을 깎아 만든 극음의 검. 칼집에 넣어두어도 서리가 맺힌다.',
      desc: '스치기만 해도 상처가 얼어붙는다. 피 한 방울 흘리지 않고 상대를 쓰러뜨리는 서늘한 검.' },
    { name: '적염검', hanja: '赤炎劍', rarity: 1, studyBonus: 990,
      lore: '남만 화산의 용암 속에서 백 일을 담금질한 극양의 보검. 대장장이는 이 검을 벼리고 눈이 멀었다 한다.',
      desc: '칼날 위로 불꽃이 아지랑이처럼 어른거린다. 베인 자리는 지혈되기도 전에 타들어간다.' },
    { name: '뇌명검', hanja: '雷鳴劍', rarity: 1, studyBonus: 1020,
      lore: '벼락 맞은 벽조목과 운철을 함께 벼려 만든 신병. 뇌우가 몰아치는 날이면 스스로 울린다.',
      desc: '휘두를 때마다 천둥소리가 터진다. 소리가 곧 기세가 되어, 마주 선 자의 담을 먼저 부순다.' },

    /* ---- 희귀 ---- */
    { name: '월광검', hanja: '月光劍', rarity: 2, studyBonus: 3600,
      lore: '아미파 역대 장문인에게만 전해지던 비검. 보름달 아래에서만 검신의 진짜 무늬가 드러난다 한다.',
      desc: '달빛을 머금은 궤적이 눈에 남아 잔상이 된다. 어느 것이 진짜 검인지 분간할 수 없다.' },
    { name: '자하검', hanja: '紫霞劍', rarity: 2, studyBonus: 3740,
      lore: '화산파 자하신공(紫霞神功)의 기운을 견디도록 특별히 주조된 검. 진기를 주입하면 보랏빛 노을이 피어오른다.',
      desc: '검을 뽑는 순간 주위가 자줏빛으로 물든다. 그 아름다움에 넋을 놓은 자는 이미 베여 있다.' },
    { name: '만년현철검', hanja: '萬年玄鐵劍', rarity: 2, studyBonus: 3890,
      lore: '만 년을 땅속에 묻혀 있던 현철 한 덩이로 만든 검. 재료값만으로 성 하나를 살 수 있다 전해진다.',
      desc: '무겁고, 단단하고, 부러지지 않는다. 어떤 신병과 부딪쳐도 이 검에 흠집을 낸 기록이 없다.' },
    { name: '용린검', hanja: '龍鱗劍', rarity: 2, studyBonus: 4030,
      lore: '동해에서 승천하다 떨어진 교룡의 비늘을 벗겨 겹겹이 이어 붙였다는 검. 진위를 아는 자는 없다.',
      desc: '검신을 덮은 비늘이 상대의 진기를 튕겨낸다. 베는 검이자 동시에 방패인 기묘한 병기.' },
    { name: '흑룡검', hanja: '黑龍劍', rarity: 2, studyBonus: 4180,
      lore: '흑룡회(黑龍會)의 초대 회주가 죽으며 관에 함께 묻었다는 마검. 도굴꾼 열둘이 이 검을 꺼내다 죽었다.',
      desc: '검신에서 검은 아지랑이가 피어오른다. 쥔 자의 살심(殺心)을 먹고 점점 무거워진다.' },
    { name: '혈마검', hanja: '血魔劍', rarity: 2, studyBonus: 4320,
      lore: '혈교(血敎)가 백 명의 고수를 제물로 바쳐 벼려냈다는 금단의 검. 정파에서는 이름조차 입에 담기를 꺼린다.',
      desc: '피를 마실수록 예리해진다. 검이 주인을 고르는 것인지, 주인이 검을 쥔 것인지 알 수 없다.' },

    /* ---- 영웅 ---- */
    { name: '구천현녀검', hanja: '九天玄女劍', rarity: 3, studyBonus: 15000,
      lore: '구천현녀(九天玄女)가 황제에게 내렸다는 하늘의 검. 그 전쟁이 끝난 뒤 삼천 년간 행방이 묘연했다.',
      desc: '검을 뽑으면 구천의 별빛이 쏟아진다. 인간의 손에 있어서는 안 될 물건이라 전해진다.' },
    { name: '뇌정천검', hanja: '雷霆天劍', rarity: 3, studyBonus: 15750,
      lore: '천겁(天劫)의 벼락을 정면으로 받아내고도 멀쩡했던 유일한 검. 검신에 벼락의 흉터가 그대로 남았다.',
      desc: '한 번 휘두를 때마다 하늘이 대신 울어준다. 이 검 앞에서는 뇌법(雷法)조차 무력해진다.' },
    { name: '사신검', hanja: '死神劍', rarity: 3, studyBonus: 16500,
      lore: '저승사자가 흘리고 간 것을 어느 나무꾼이 주웠다는 검. 그 나무꾼의 이름은 아무도 기억하지 못한다.',
      desc: '베인 자는 아픔을 느끼지 못한다. 다만 자신이 이미 죽었다는 사실을 뒤늦게 깨달을 뿐이다.' },
    { name: '파천검', hanja: '破天劍', rarity: 3, studyBonus: 17250,
      lore: '하늘을 원망한 어느 패왕이 삼십 년을 바쳐 만든 검. 완성된 날 그는 하늘을 향해 이 검을 휘둘렀다.',
      desc: '이름 그대로 하늘을 가른다. 검압만으로 산 하나가 두 쪽 나는 것을 본 자가 있다.' },
    { name: '천마검', hanja: '天魔劍', rarity: 3, studyBonus: 18000,
      lore: '천마신교 역대 교주만이 쥘 수 있었던 마도의 상징. 자격 없는 자가 쥐면 검이 주인을 벤다.',
      desc: '하늘의 마(魔)를 담았다. 이 검을 뽑는 순간, 강호의 모든 정파가 동시에 검을 뽑는다.' },

    /* ---- 전설 ---- */
    { name: '주선검', hanja: '誅仙劍', rarity: 4, studyBonus: 62000,
      lore: '주선사검진(誅仙四劍陣)의 첫째 검. 선인을 베기 위해 만들어졌고, 실제로 선인을 베었다.',
      desc: '신선조차 이 검 앞에서는 필멸의 존재가 된다. 하늘의 이치로도 이 검날은 막지 못한다.' },
    { name: '개천검', hanja: '開天劍', rarity: 4, studyBonus: 66100,
      lore: '닫힌 하늘을 강제로 열어젖혔다는 창세의 신검. 반고 이후 두 번째로 하늘을 가른 자만이 이 검을 얻는다.',
      desc: '한 번 그으면 하늘에 길이 난다. 그 틈으로 무엇이 들어오는지는 아무도 알지 못한다.' },
    { name: '반고신검', hanja: '盤古神劍', rarity: 4, studyBonus: 70200,
      lore: '천지를 개벽한 반고(盤古)가 혼돈을 가를 때 쥐었던 도끼가, 세월을 거쳐 검으로 화한 것이라 전해진다.',
      desc: '이 검을 쥔 자는 곧 하늘이 된다. 다만 그 무게를 견딘 자가 반고 외에 아직 없을 뿐이다.' },
    { name: '창세검', hanja: '創世劍', rarity: 4, studyBonus: 74400,
      lore: '무(無)에서 유(有)를 빚어낸 태초의 권능이 깃든 검. 존재한다는 기록만 있고 본 자는 없다.',
      desc: '베는 것이 아니라 「없던 것으로 만든다」. 이 검에 지워진 것은 기억에서조차 사라진다.' },

    /* ---- 신화 ---- */
    { name: '삼라만상검', hanja: '森羅萬象劍', rarity: 5, studyBonus: 260000,
      lore: '세상 만물의 이치가 검신에 아로새겨진 검. 검을 들여다보면 자신의 일생이 보인다고 한다.',
      desc: '이 검은 그 자체로 하나의 우주다. 휘두르는 것은 검이 아니라 세계의 법칙 그 자체다.' },
    { name: '태극혼돈검', hanja: '太極混沌劍', rarity: 5, studyBonus: 286000,
      lore: '혼돈에서 태극이, 태극에서 삼라만상이 태어났다. 그 최초의 갈라짐을 그대로 굳혀 만든 검.',
      desc: '음과 양, 유와 무가 검신 위에서 끝없이 뒤섞인다. 이 검의 궤적은 인과율조차 따라오지 못한다.' },
    { name: '무형검', hanja: '無形劍', rarity: 5, studyBonus: 312000,
      lore: '형(形)조차 초월한 검의 종착점. 어떤 대장장이도 이 검을 만들지 않았고, 어떤 자도 이 검을 주웠다 하지 않는다.',
      desc: '검을 쥐지 않아도, 그 앞에 설 자가 없다. 무형검을 얻었다는 것은 곧 검을 넘어섰다는 뜻이다.' },
  ];

  const BASE_STUDY_MIN = 250;

  /* ---------------- Quotes ---------------- */
  const QUOTES = [
    '정말로 최선을 다해라. 조금도 부끄럽지 않도록.',
  ];

  /* ---------------- Rendering: Schedules ---------------- */
  function renderSchedules() {
    scheduleList.innerHTML = '';
    const todayK = todayKey();

    const withDiff = schedules.map((s) => ({ ...s, diff: daysBetween(todayK, s.date) }));
    const upcoming = withDiff.filter((s) => s.diff >= 0).sort((a, b) => a.diff - b.diff);
    const past = withDiff.filter((s) => s.diff < 0).sort((a, b) => b.diff - a.diff);
    const ordered = [...upcoming, ...past];

    scheduleBadge.textContent = `${schedules.length}개`;
    scheduleEmpty.style.display = schedules.length ? 'none' : 'block';
    upcomingCount.textContent = upcoming.length;

    ordered.forEach((s) => {
      const node = scheduleItemTpl.content.cloneNode(true);
      const li = node.querySelector('.schedule-item');
      const pill = node.querySelector('.dday-pill');
      const title = node.querySelector('.schedule-title');
      const dateEl = node.querySelector('.schedule-date');
      const delBtn = node.querySelector('.delete-btn');

      title.textContent = s.title;
      dateEl.textContent = formatHuman(s.date);

      if (s.diff === 0) {
        pill.textContent = 'D-DAY';
        pill.classList.add('today');
      } else if (s.diff > 0) {
        pill.textContent = `D-${s.diff}`;
      } else {
        pill.textContent = `D+${Math.abs(s.diff)}`;
        pill.classList.add('past');
      }

      delBtn.addEventListener('click', () => {
        schedules = schedules.filter((x) => x.id !== s.id);
        queueSave();
        renderSchedules();
      });

      li.dataset.id = s.id;
      scheduleList.appendChild(node);
    });
  }

  scheduleForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = scheduleTitleInput.value.trim();
    const date = scheduleDateInput.value;
    if (!title || !date) return;
    schedules.push({ id: crypto.randomUUID(), title, date });
    queueSave();
    scheduleForm.reset();
    renderSchedules();
  });

  /* ---------------- Rendering: Todos ---------------- */
  function getTodosFor(dateKey) {
    return todosByDate[dateKey] || [];
  }

  function computeDayPercent(dateKey) {
    const items = getTodosFor(dateKey);
    if (!items.length) return null;
    const sum = items.reduce((acc, t) => acc + (t.done ? 100 : t.percent), 0);
    return Math.round(sum / items.length);
  }

  function renderTodos() {
    const items = getTodosFor(viewingDateKey);
    todoList.innerHTML = '';
    todoEmpty.style.display = items.length ? 'none' : 'block';

    viewingDateLabel.textContent = formatHuman(viewingDateKey);
    todoCount.textContent = viewingDateKey === todayKey() ? items.length : todoCount.textContent;

    items.forEach((t) => {
      const node = todoItemTpl.content.cloneNode(true);
      const li = node.querySelector('.todo-item');
      const checkBtn = node.querySelector('.check-btn');
      const textEl = node.querySelector('.todo-text');
      const slider = node.querySelector('.percent-slider');
      const percentValue = node.querySelector('.percent-value');
      const delBtn = node.querySelector('.delete-btn');

      textEl.textContent = t.text;
      slider.value = t.done ? 100 : t.percent;
      percentValue.textContent = `${t.done ? 100 : t.percent}%`;
      if (t.done) {
        li.classList.add('done');
        checkBtn.classList.add('done');
        checkBtn.textContent = '✓';
        slider.disabled = true;
      }

      checkBtn.addEventListener('click', () => {
        t.done = !t.done;
        if (t.done) t.percent = 100;
        persistTodos();
        renderTodos();
        renderSummary();
        renderHeader();
        renderHeatmap();
      });

      slider.addEventListener('input', () => {
        t.percent = Number(slider.value);
        if (t.percent >= 100) {
          t.done = true;
          t.percent = 100;
        } else {
          t.done = false;
        }
        percentValue.textContent = `${t.percent}%`;
        persistTodos();
        renderSummary();
        renderHeader();
        renderHeatmap();
        if (t.done) renderTodos();
      });

      delBtn.addEventListener('click', () => {
        todosByDate[viewingDateKey] = getTodosFor(viewingDateKey).filter((x) => x.id !== t.id);
        persistTodos();
        renderTodos();
        renderSummary();
        renderHeader();
        renderHeatmap();
      });

      li.dataset.id = t.id;
      todoList.appendChild(node);
    });
  }

  function persistTodos() {
    queueSave();
  }

  function renderSummary() {
    const pct = computeDayPercent(viewingDateKey) ?? 0;
    daySummaryFill.style.width = `${pct}%`;
    daySummaryPercent.textContent = `${pct}%`;
  }

  todoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = todoTextInput.value.trim();
    if (!text) return;
    if (!todosByDate[viewingDateKey]) todosByDate[viewingDateKey] = [];
    todosByDate[viewingDateKey].push({ id: crypto.randomUUID(), text, done: false, percent: 0 });
    persistTodos();
    todoForm.reset();
    renderTodos();
    renderSummary();
    renderHeader();
    renderHeatmap();
  });

  prevDayBtn.addEventListener('click', () => {
    viewingDateKey = addDays(viewingDateKey, -1);
    renderTodos();
    renderSummary();
  });
  nextDayBtn.addEventListener('click', () => {
    viewingDateKey = addDays(viewingDateKey, 1);
    renderTodos();
    renderSummary();
  });
  jumpTodayBtn.addEventListener('click', () => {
    viewingDateKey = todayKey();
    renderTodos();
    renderSummary();
  });

  /* ---------------- Header (ring, streak, quote) ---------------- */
  function computeStreak() {
    let streak = 0;
    let cursor = todayKey();
    // if today has no data yet, start counting from yesterday
    if (computeDayPercent(cursor) === null) {
      cursor = addDays(cursor, -1);
    }
    while (true) {
      const pct = computeDayPercent(cursor);
      if (pct !== null && pct >= 80) {
        streak += 1;
        cursor = addDays(cursor, -1);
      } else {
        break;
      }
    }
    return streak;
  }

  function renderHeader() {
    const todayK = todayKey();
    const now = new Date();
    todayDateEl.textContent = now.toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    });

    const pct = computeDayPercent(todayK) ?? 0;
    const offset = RING_CIRCUMFERENCE - (pct / 100) * RING_CIRCUMFERENCE;
    ringFg.style.strokeDashoffset = String(offset);
    ringPercent.textContent = `${pct}%`;
    ringFg.style.stroke = pct >= 80 ? 'var(--accent-3)' : 'var(--accent)';

    streakValue.textContent = computeStreak();
    todoCount.textContent = getTodosFor(todayK).length;

    const withDiff = schedules.map((s) => ({ ...s, diff: daysBetween(todayK, s.date) }));
    upcomingCount.textContent = withDiff.filter((s) => s.diff >= 0).length;

    const qIndex = new Date().getDate() % QUOTES.length;
    motivationQuote.textContent = QUOTES[qIndex];
  }

  /* ---------------- Heatmap ---------------- */
  function renderHeatmap() {
    heatmap.innerHTML = '';
    const todayK = todayKey();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(todayK, -i));

    let hasAny = false;

    days.forEach((key) => {
      const pct = computeDayPercent(key);
      const studySeconds = sumStudySecondsForDate(key);
      if (pct !== null || studySeconds > 0) hasAny = true;
      const cell = document.createElement('div');
      cell.className = 'heat-cell' + (pct === null ? ' empty' : '') + (key === todayK ? ' today-cell' : '');
      if (pct !== null) {
        const intensity = 0.25 + (pct / 100) * 0.75;
        cell.style.background = `linear-gradient(135deg, rgba(124,92,255,${intensity}), rgba(255,111,165,${intensity}))`;
      }
      const dayLabel = document.createElement('span');
      dayLabel.className = 'heat-day';
      dayLabel.textContent = formatShort(key);
      const pctLabel = document.createElement('span');
      pctLabel.className = 'heat-pct';
      pctLabel.textContent = pct === null ? '–' : `${pct}%`;
      const studyLabel = document.createElement('span');
      studyLabel.className = 'heat-study';
      studyLabel.textContent = studySeconds > 0 ? formatDurationLabel(studySeconds) : '0분';
      cell.appendChild(dayLabel);
      cell.appendChild(pctLabel);
      cell.appendChild(studyLabel);
      heatmap.appendChild(cell);
    });

    historyEmpty.style.display = hasAny ? 'none' : 'block';
  }

  /* ---------------- Toast ---------------- */
  let toastTimeout = null;
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  /* ---------------- Gold ---------------- */
  function renderGold() {
    goldAmountEl.textContent = gold.toLocaleString('ko-KR');
  }

  function addGold(amount) {
    gold += amount;
    queueSave();
    renderGold();
  }

  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  /* ---------------- Tabs ---------------- */
  function switchTab(name) {
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
    Object.entries(tabPanels).forEach(([key, panel]) => panel.classList.toggle('active', key === name));
    if (name === 'ranking') renderRanking(currentRankCategory);
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ---------------- Ranking ---------------- */
  const RANK_CATEGORIES = {
    realm: { column: 'realm_level', label: (v) => (REALMS[v] ? `${REALMS[v].name} (${REALMS[v].hanja})` : '-') },
    sword: {
      column: 'sword_level',
      label: (v) => (SWORDS[v] ? `[${RARITIES[SWORDS[v].rarity].name}] ${SWORDS[v].name}` : '-'),
    },
    gold: { column: 'gold', label: (v) => `${(v || 0).toLocaleString('ko-KR')}C` },
    study_today: { column: 'study_today', label: (v) => formatDurationLabel(v || 0) },
    study_week: { column: 'study_week', label: (v) => formatDurationLabel(v || 0) },
    study_month: { column: 'study_month', label: (v) => formatDurationLabel(v || 0) },
  };
  let currentRankCategory = 'realm';

  async function renderRanking(category) {
    currentRankCategory = category;
    rankCategoryButtons.forEach((b) => b.classList.toggle('active', b.dataset.cat === category));
    const cfg = RANK_CATEGORIES[category];

    const { data, error } = await sb
      .from('leaderboard')
      .select('*')
      .order(cfg.column, { ascending: false })
      .limit(200);

    const rows = error ? [] : (data || []);
    rankList.innerHTML = '';
    rankEmpty.style.display = rows.length ? 'none' : 'block';

    const myIndex = rows.findIndex((r) => r.user_id === currentUserId);
    myRankEl.textContent = myIndex >= 0 ? `내 순위 ${myIndex + 1}위` : '순위 없음';

    rows.forEach((row, i) => {
      const rank = i + 1;
      const node = rankRowTpl.content.cloneNode(true);
      const li = node.querySelector('.rank-row');
      node.querySelector('.rank-medal').textContent =
        rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);
      if (rank <= 3) li.classList.add(`top${rank}`);
      if (row.user_id === currentUserId) li.classList.add('me');
      node.querySelector('.rank-username').textContent = row.username || '익명';
      node.querySelector('.rank-value').textContent = cfg.label(row[cfg.column]);
      rankList.appendChild(node);
    });
  }

  rankCategoryButtons.forEach((btn) => btn.addEventListener('click', () => renderRanking(btn.dataset.cat)));

  /* ---------------- Study Timer ---------------- */
  let selectedSubjectId = activeSession ? activeSession.subjectId : null;
  let tickInterval = null;

  const formatDuration = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  };

  const formatDurationLabel = (totalSeconds) => {
    const mins = Math.floor(totalSeconds / 60);
    if (mins < 60) return `${mins}분`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  };
  const formatStudyLabel = (totalSeconds) => `오늘 ${formatDurationLabel(totalSeconds)}`;

  function getStudySeconds(dateKey, subjectId) {
    return (studyByDate[dateKey] && studyByDate[dateKey][subjectId]) || 0;
  }

  function addStudySeconds(dateKey, subjectId, seconds) {
    if (!studyByDate[dateKey]) studyByDate[dateKey] = {};
    studyByDate[dateKey][subjectId] = (studyByDate[dateKey][subjectId] || 0) + seconds;
    queueSave();
  }

  function renderSubjects() {
    const todayK = todayKey();
    subjectList.innerHTML = '';
    subjectBadge.textContent = `${subjects.length}개`;
    subjectEmpty.style.display = subjects.length ? 'none' : 'block';

    subjects.forEach((s) => {
      const node = subjectItemTpl.content.cloneNode(true);
      const li = node.querySelector('.subject-item');
      const selectBtn = node.querySelector('.subject-select-btn');
      const nameEl = node.querySelector('.subject-name');
      const timeEl = node.querySelector('.subject-time');
      const delBtn = node.querySelector('.delete-btn');

      nameEl.textContent = s.name;
      timeEl.textContent = formatStudyLabel(getStudySeconds(todayK, s.id));

      const isRunning = !!(activeSession && activeSession.subjectId === s.id);
      if (isRunning) {
        li.classList.add('running');
        selectBtn.textContent = '■';
      } else if (selectedSubjectId === s.id) {
        li.classList.add('selected');
        selectBtn.textContent = '▶';
      } else {
        selectBtn.textContent = '▶';
      }

      selectBtn.addEventListener('click', () => selectSubject(s.id));
      delBtn.addEventListener('click', () => {
        if (activeSession && activeSession.subjectId === s.id) {
          showToast('측정 중인 과목은 삭제할 수 없어요. 먼저 종료해주세요.');
          return;
        }
        subjects = subjects.filter((x) => x.id !== s.id);
        queueSave();
        if (selectedSubjectId === s.id) selectedSubjectId = null;
        renderSubjects();
        renderTimerUI();
      });

      li.dataset.id = s.id;
      subjectList.appendChild(node);
    });
  }

  function selectSubject(id) {
    if (activeSession) {
      if (activeSession.subjectId === id) stopTimer();
      else showToast('측정 중에는 다른 과목을 선택할 수 없어요.');
      return;
    }
    selectedSubjectId = selectedSubjectId === id ? null : id;
    renderSubjects();
    renderTimerUI();
  }

  function renderTimerUI() {
    if (activeSession) {
      const subj = subjects.find((s) => s.id === activeSession.subjectId);
      timerSubjectLabel.textContent = subj ? subj.name : '';
      measureBtn.disabled = false;
      measureBtn.textContent = '■ 측정 종료';
      measureBtn.classList.add('running');
      return;
    }
    const selected = subjects.find((s) => s.id === selectedSubjectId);
    timerDisplay.textContent = '00:00:00';
    measureBtn.classList.remove('running');
    if (selected) {
      timerSubjectLabel.textContent = selected.name;
      measureBtn.disabled = false;
      measureBtn.textContent = '▶ 측정 시작';
    } else {
      timerSubjectLabel.textContent = '과목을 선택해주세요';
      measureBtn.disabled = true;
      measureBtn.textContent = '▶ 측정 시작';
    }
  }

  function tick() {
    if (!activeSession) return;
    const elapsed = Math.floor((Date.now() - activeSession.startTs) / 1000);
    timerDisplay.textContent = formatDuration(elapsed);
    renderTodayTotal();
  }

  function renderTodayTotal() {
    let total = sumStudySecondsForDate(todayKey());
    if (activeSession) total += Math.floor((Date.now() - activeSession.startTs) / 1000);
    todayTotalDisplay.textContent = formatDuration(total);
  }

  function startTicking() {
    if (tickInterval) clearInterval(tickInterval);
    tick();
    tickInterval = setInterval(tick, 1000);
  }

  function startTimer(subjectId) {
    activeSession = { subjectId, startTs: Date.now() };
    queueSave();
    renderSubjects();
    renderTimerUI();
    startTicking();
  }

  function stopTimer() {
    if (!activeSession) return;
    const elapsedSeconds = Math.floor((Date.now() - activeSession.startTs) / 1000);
    const subjectId = activeSession.subjectId;
    const subj = subjects.find((s) => s.id === subjectId);

    clearInterval(tickInterval);
    tickInterval = null;
    addStudySeconds(todayKey(), subjectId, elapsedSeconds);

    const blocks = Math.floor(elapsedSeconds / 60);
    const [rangeMin, rangeMax] = currentStudyRange();
    let reward = 0;
    for (let i = 0; i < blocks; i++) reward += randomInt(rangeMin, rangeMax);

    activeSession = null;
    queueSave();

    if (reward > 0) {
      addGold(reward);
      showToast(`⏱️ ${subj ? subj.name : '공부'} 측정 완료! +${reward.toLocaleString('ko-KR')} 골드 획득 🪙`);
    } else {
      showToast('⏱️ 측정 종료! 1분을 채우면 골드를 받을 수 있어요.');
    }

    renderSubjects();
    renderTimerUI();
    renderTodayTotal();
    renderHeader();
  }

  measureBtn.addEventListener('click', () => {
    if (activeSession) stopTimer();
    else if (selectedSubjectId) startTimer(selectedSubjectId);
  });

  subjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = subjectTextInput.value.trim();
    if (!name) return;
    subjects.push({ id: crypto.randomUUID(), name });
    queueSave();
    subjectForm.reset();
    renderSubjects();
  });

  /* ---------------- Cultivation bonuses (경지 + 검 → 골드 획득량) ---------------- */
  function cumulativeBonus(list, level, field) {
    let sum = 0;
    for (let i = 0; i <= level; i++) sum += list[i][field];
    return sum;
  }

  /* Realms stack (you keep every rung you climbed); a sword does not —
     only the single blade you have equipped counts. */
  function studyRangeAt(realmIdx, swordIdx) {
    const bonus = cumulativeBonus(REALMS, realmIdx, 'studyBonus') + SWORDS[swordIdx].studyBonus;
    const min = BASE_STUDY_MIN + bonus;
    return [min, min * 2];
  }

  function currentStudyRange() { return studyRangeAt(realmLevel, swordLevel); }

  function renderStudyHint() {
    const [min, max] = currentStudyRange();
    timerHint.textContent = `1분마다 ${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')} 골드를 획득해요 🪙`;
  }

  /* ---------------- 경지 승급 (경지 트랙) ---------------- */
  const CULT_TRACKS = {
    realm: {
      axis: 'realm',
      list: REALMS,
      getLevel: () => realmLevel,
      setLevel: (v) => { realmLevel = v; queueSave(); },
      getOtherLevel: () => swordLevel,
      els: {
        name: el('realmName'), hanja: el('realmHanja'), desc: el('realmDesc'),
        studyRange: el('realmStudyRange'), badge: el('realmBadge'),
        nextName: el('realmNextName'), upgradeBtn: el('realmUpgradeBtn'), ladderList: el('realmLadderList'),
      },
      maxedNextText: '이미 구도의 완성, 여의경(如意境) 극에 이르렀습니다',
      verb: '경지에 올랐습니다',
    },
  };

  function rangeForTrackIndex(track, index) {
    return studyRangeAt(index, track.getOtherLevel());
  }
  const tierOf = (index) => Math.floor(index / 3);

  function renderCultivationTrack(track) {
    const level = track.getLevel();
    const cur = track.list[level];
    const e = track.els;

    e.name.textContent = cur.name;
    e.name.className = `cultivation-name tier-${tierOf(level)}`;
    e.hanja.textContent = `(${cur.hanja})`;
    e.desc.textContent = cur.desc;
    const [min, max] = rangeForTrackIndex(track, level);
    e.studyRange.textContent = `${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')}C`;
    e.badge.textContent = `${level + 1} / ${track.list.length}`;

    const next = track.list[level + 1];
    if (next) {
      e.nextName.textContent = `${next.name} (${next.hanja})`;
      e.upgradeBtn.textContent = `${next.price.toLocaleString('ko-KR')}C로 승급하기`;
      e.upgradeBtn.disabled = gold < next.price;
      e.upgradeBtn.classList.remove('maxed');
      e.upgradeBtn.onclick = () => upgradeTrack(track);
    } else {
      e.nextName.textContent = track.maxedNextText;
      e.upgradeBtn.textContent = '달성 완료';
      e.upgradeBtn.disabled = true;
      e.upgradeBtn.classList.add('maxed');
      e.upgradeBtn.onclick = null;
    }

    e.ladderList.innerHTML = '';
    track.list.forEach((item, i) => {
      const node = ladderRowTpl.content.cloneNode(true);
      const li = node.querySelector('.ladder-row');
      node.querySelector('.ladder-rank').textContent = i + 1;
      const nameEl = node.querySelector('.ladder-name');
      nameEl.textContent = item.name;
      nameEl.classList.add(`tier-${tierOf(i)}`);
      node.querySelector('.ladder-hanja').textContent = `(${item.hanja})`;
      const [rmin, rmax] = rangeForTrackIndex(track, i);
      node.querySelector('.ladder-range').textContent = `${rmin.toLocaleString('ko-KR')}~${rmax.toLocaleString('ko-KR')}C`;
      const statusEl = node.querySelector('.ladder-status');
      if (i < level) { li.classList.add('done'); statusEl.textContent = '달성'; }
      else if (i === level) { li.classList.add('current'); statusEl.textContent = '현재'; }
      else { li.classList.add('locked'); statusEl.textContent = `${item.price.toLocaleString('ko-KR')}C`; }
      e.ladderList.appendChild(node);
    });
  }

  function upgradeTrack(track) {
    const level = track.getLevel();
    const next = track.list[level + 1];
    if (!next || gold < next.price) return;

    gold -= next.price;
    renderGold();
    track.setLevel(level + 1);
    showToast(`🌟 ${next.name}(${next.hanja}) ${track.verb}`);

    renderCultivationTrack(CULT_TRACKS.realm);
    renderGachaPanel();
    renderStudyHint();
  }

  /* ---------------- 검 뽑기 (가챠) ----------------
     One draw costs roughly five minutes of study at your current realm, so
     the pull stays meaningful from 삼류무사 all the way to 여의경. The sword
     you have equipped deliberately does NOT feed into the price — otherwise
     a lucky pull would immediately tax every pull after it. */
  const DRAW_COST_MINUTES = 5;
  const MAX_DRAWS_PER_BATCH = 100;

  function niceCost(n) {
    if (n < 1000) return Math.round(n / 10) * 10;
    if (n < 10000) return Math.round(n / 100) * 100;
    if (n < 1000000) return Math.round(n / 1000) * 1000;
    if (n < 100000000) return Math.round(n / 100000) * 100000;
    return Math.round(n / 1000000) * 1000000;
  }

  function drawCost() {
    const perMinuteAvg = (BASE_STUDY_MIN + cumulativeBonus(REALMS, realmLevel, 'studyBonus')) * 1.5;
    return niceCost(perMinuteAvg * DRAW_COST_MINUTES);
  }

  /* Pick a grade by its fixed odds, then any sword inside it uniformly —
     that is what makes every sword of one grade equally likely. */
  function rollSword() {
    let roll = Math.random() * 100;
    let rarity = 0;
    for (let i = 0; i < RARITIES.length; i++) {
      if (roll < RARITIES[i].chance) { rarity = i; break; }
      roll -= RARITIES[i].chance;
      rarity = i;
    }
    const pool = SWORDS.map((s, i) => (s.rarity === rarity ? i : -1)).filter((i) => i >= 0);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function performDraws(count) {
    const cost = drawCost();
    const total = cost * count;
    if (gold < total) {
      showToast(`💸 골드가 부족해요. ${count}회 뽑기에 ${total.toLocaleString('ko-KR')}C가 필요합니다.`);
      return;
    }

    gold -= total;

    const results = [];
    let equippedChanged = false;
    let newlyDiscovered = 0;

    for (let i = 0; i < count; i++) {
      const idx = rollSword();
      const isNew = !discovered.includes(idx);
      if (isNew) { discovered.push(idx); newlyDiscovered++; }
      // Higher index is always the stronger blade, so this is the whole
      // "better sword auto-equips, weaker one is kept but not worn" rule.
      const upgraded = idx > swordLevel;
      if (upgraded) { swordLevel = idx; equippedChanged = true; }
      results.push({ idx, isNew, upgraded });
    }

    queueSave();
    renderGold();
    renderGachaResults(results);
    renderGachaPanel();
    renderCodex();
    renderStudyHint();

    const best = results.reduce((a, b) => (b.idx > a.idx ? b : a));
    const bestSword = SWORDS[best.idx];
    if (equippedChanged) {
      showToast(`⚔️ ${RARITIES[bestSword.rarity].name} ${bestSword.name}(${bestSword.hanja}) 획득! 자동으로 장착했습니다.`);
    } else if (newlyDiscovered > 0) {
      showToast(`📖 새로운 검 ${newlyDiscovered}자루를 도감에 기록했습니다.`);
    } else {
      showToast('🌀 이번엔 더 좋은 검이 나오지 않았어요. 현재 검을 그대로 유지합니다.');
    }
  }

  /* ---------------- 뽑기 화면 ---------------- */
  const gachaCountInput = el('gachaCount');
  const gachaDrawBtn = el('gachaDrawBtn');
  const gachaCostLabel = el('gachaCostLabel');
  const gachaResults = el('gachaResults');
  const gachaResultsEmpty = el('gachaResultsEmpty');
  const rarityTable = el('rarityTable');
  const swordResultTpl = el('swordResultTemplate');
  const codexGrid = el('codexGrid');
  const codexProgress = el('codexProgress');
  const codexCardTpl = el('codexCardTemplate');

  const equippedEls = {
    name: el('swordName'), hanja: el('swordHanja'), grade: el('swordGrade'),
    lore: el('swordLore'), desc: el('swordDesc'), studyRange: el('swordStudyRange'),
  };

  function clampDrawCount() {
    let n = parseInt(gachaCountInput.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > MAX_DRAWS_PER_BATCH) n = MAX_DRAWS_PER_BATCH;
    return n;
  }

  function renderGachaPanel() {
    const cur = SWORDS[swordLevel];
    const rar = RARITIES[cur.rarity];

    equippedEls.name.textContent = cur.name;
    equippedEls.name.className = `cultivation-name rar-${cur.rarity}`;
    equippedEls.hanja.textContent = `(${cur.hanja})`;
    equippedEls.grade.textContent = `${rar.name} · ${rar.hanja}`;
    equippedEls.grade.className = `sword-grade rar-chip rar-${cur.rarity}`;
    equippedEls.lore.textContent = cur.lore;
    equippedEls.desc.textContent = cur.desc;
    const [min, max] = studyRangeAt(realmLevel, swordLevel);
    equippedEls.studyRange.textContent = `${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')}C`;

    const n = clampDrawCount();
    const cost = drawCost();
    const total = cost * n;
    gachaCostLabel.textContent = `1회 ${cost.toLocaleString('ko-KR')}C · ${n}회 ${total.toLocaleString('ko-KR')}C`;
    gachaDrawBtn.textContent = `${n}회 뽑기`;
    gachaDrawBtn.disabled = gold < total;

    rarityTable.innerHTML = '';
    RARITIES.forEach((r, i) => {
      const count = SWORDS.filter((s) => s.rarity === i).length;
      const li = document.createElement('li');
      li.className = `rarity-row rar-${i}`;
      li.innerHTML = `
        <span class="rarity-name">${r.name}<small>${r.hanja}</small></span>
        <span class="rarity-chance">${r.chance}%</span>
        <span class="rarity-count">${count}종</span>`;
      rarityTable.appendChild(li);
    });
  }

  function renderGachaResults(results) {
    gachaResults.innerHTML = '';
    gachaResultsEmpty.style.display = results.length ? 'none' : 'block';
    results.forEach((r, i) => {
      const s = SWORDS[r.idx];
      const node = swordResultTpl.content.cloneNode(true);
      const card = node.querySelector('.sword-result');
      card.classList.add(`rar-${s.rarity}`);
      if (r.upgraded) card.classList.add('upgraded');
      card.style.animationDelay = `${Math.min(i, 20) * 35}ms`;
      node.querySelector('.sword-result-grade').textContent = RARITIES[s.rarity].name;
      node.querySelector('.sword-result-name').textContent = s.name;
      node.querySelector('.sword-result-hanja').textContent = s.hanja;
      const tag = node.querySelector('.sword-result-tag');
      if (r.upgraded) tag.textContent = '장착!';
      else if (r.isNew) tag.textContent = 'NEW';
      else tag.remove();
      gachaResults.appendChild(node);
    });
  }

  /* ---------------- 도감 ---------------- */
  function renderCodex() {
    codexGrid.innerHTML = '';
    codexProgress.textContent = `${discovered.length} / ${SWORDS.length}`;

    SWORDS.forEach((s, i) => {
      const found = discovered.includes(i);
      const node = codexCardTpl.content.cloneNode(true);
      const card = node.querySelector('.codex-card');
      card.classList.add(`rar-${s.rarity}`);
      if (!found) card.classList.add('locked');
      if (i === swordLevel) card.classList.add('equipped');

      node.querySelector('.codex-grade').textContent = RARITIES[s.rarity].name;
      node.querySelector('.codex-name').textContent = s.name;   // name is always shown
      node.querySelector('.codex-hanja').textContent = found ? `(${s.hanja})` : '(???)';
      node.querySelector('.codex-lore').textContent = found ? s.lore : '???';
      node.querySelector('.codex-desc').textContent = found ? s.desc : '???';
      node.querySelector('.codex-bonus').textContent = found
        ? `분당 +${s.studyBonus.toLocaleString('ko-KR')}C`
        : '분당 +???';
      codexGrid.appendChild(node);
    });
  }

  gachaCountInput.addEventListener('input', renderGachaPanel);
  gachaDrawBtn.addEventListener('click', () => performDraws(clampDrawCount()));

  /* ---------------- Theme ---------------- */
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    themeSwitch.setAttribute('aria-checked', String(isDark));
  }

  themeSwitch.addEventListener('click', () => {
    const current = load(THEME_KEY, 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    save(THEME_KEY, next);
    applyTheme(next);
  });

  applyTheme(load(THEME_KEY, 'dark'));

  /* ---------------- Accounts (Supabase Auth) ---------------- */
  function usernameError(username) {
    if (!username) return '아이디를 입력해주세요.';
    if (!/^[a-zA-Z0-9_-]{2,24}$/.test(username)) return '아이디는 영문/숫자/_/- 2~24자로 입력해주세요.';
    return null;
  }

  async function trySignup(username, password) {
    const unameErr = usernameError(username);
    if (unameErr) return unameErr;
    if (!password || password.length < 4) return '비밀번호는 4자 이상이어야 해요.';
    const { error } = await sb.auth.signUp({
      email: usernameToEmail(username),
      password,
      options: { data: { username } },
    });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) return '이미 존재하는 아이디예요.';
      return `회원가입에 실패했어요: ${error.message}`;
    }
    return null;
  }

  async function tryLogin(username, password) {
    const unameErr = usernameError(username);
    if (unameErr) return unameErr;
    const { error } = await sb.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error) return '아이디 또는 비밀번호가 올바르지 않아요.';
    return null;
  }

  logoutBtn.addEventListener('click', async () => {
    if (saveTimer) await flushSave();
    await sb.auth.signOut();
  });

  let authMode = 'login';
  authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.mode;
      authTabs.forEach((t) => t.classList.toggle('active', t === tab));
      authSubmitBtn.textContent = authMode === 'login' ? '로그인' : '회원가입';
      authPasswordInput.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      authError.textContent = '';
    });
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = authUsernameInput.value.trim();
    const password = authPasswordInput.value;
    authSubmitBtn.disabled = true;
    authError.textContent = '';
    try {
      const errorMsg = authMode === 'login'
        ? await tryLogin(username, password)
        : await trySignup(username, password);
      if (errorMsg) authError.textContent = errorMsg;
      // On success, onAuthStateChange below picks up the new session and enters the app.
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  /* ---------------- Init ---------------- */
  function init() {
    scheduleDateInput.min = todayKey();
    renderSchedules();
    renderTodos();
    renderSummary();
    renderHeader();
    renderHeatmap();

    renderGold();
    renderSubjects();
    renderTimerUI();
    renderStudyHint();
    renderTodayTotal();
    if (activeSession) startTicking();
    renderCultivationTrack(CULT_TRACKS.realm);
    renderGachaPanel();
    renderGachaResults([]);
    renderCodex();
  }

  /* ---------------- Session lifecycle ---------------- */
  async function enterApp(user) {
    currentUserId = user.id;
    currentUsername = user.user_metadata?.username || user.email.split('@')[0];
    settingsUsernameEl.textContent = currentUsername;
    await loadUserState();
    await flushSave(); // keep the leaderboard row fresh even if nothing changes this session
    authGate.classList.add('hidden');
    init();
  }

  let sessionKnownUserId = undefined;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      location.reload();
      return;
    }
    const user = session?.user;
    if (user && user.id !== sessionKnownUserId) {
      sessionKnownUserId = user.id;
      enterApp(user);
    } else if (!user) {
      authGate.classList.remove('hidden');
    }
  });
})();
