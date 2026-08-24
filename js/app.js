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

  /* Supabase RLS only restricts a row to its owner — it says nothing about
     what's INSIDE the row, so any field a user can write is really just
     "whatever that user's browser (or a raw API call, bypassing this app
     entirely) chose to send". avatar rides into every other viewer's
     leaderboard render and gets spliced into a CSS url(...), so an
     unvalidated value there is a stored injection point (CSS injection,
     tracking-pixel beacons via background-image) affecting everyone who
     opens the 랭킹 tab, not just its owner. This client-side check can't
     stop a determined attacker from writing garbage to their own row
     (only a DB-side constraint can), but it does stop that garbage from
     ever being trusted and rendered back out to other users. */
  const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
  const isSafeAvatarUrl = (v) => typeof v === 'string' && v.length <= 40000 && AVATAR_DATA_URL_RE.test(v);

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
  let nickname = '';       // shown on the leaderboard instead of the account id, once set
  let avatar = null;       // small data URL, or null for the placeholder icon
  let starFragments = 0;   // 별의 조각 — earned by drawing a sword you already own
  let swordStars = {};     // { [swordIdx]: 0-10 } — 강화 level per individually owned sword
  let totalDraws = 0;      // lifetime count of swords drawn (검 뽑기 tab), for the 랭킹 tab

  /* Bumped whenever the sword table is reshaped, so stale sword indices
     from an older layout can't silently point at the wrong blade. */
  const SWORD_TABLE_VERSION = 3;

  function collectState() {
    return {
      schedules, todosByDate, gold, subjects, studyByDate, activeSession,
      realmLevel, swordLevel, discovered, swordTableVersion: SWORD_TABLE_VERSION,
      nickname, avatar, starFragments, swordStars, totalDraws,
    };
  }

  function applyState(data) {
    schedules = data.schedules ?? [];
    todosByDate = data.todosByDate ?? {};
    subjects = data.subjects ?? [];
    studyByDate = data.studyByDate ?? {};
    activeSession = data.activeSession ?? null;
    realmLevel = Number.isFinite(data.realmLevel) ? Math.floor(data.realmLevel) : 0;
    realmLevel = Math.min(Math.max(realmLevel, 0), REALMS.length - 1);

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

    nickname = typeof data.nickname === 'string' ? data.nickname.slice(0, 16) : '';
    avatar = isSafeAvatarUrl(data.avatar) ? data.avatar : null;

    gold = Number.isFinite(data.gold) ? Math.max(0, Math.floor(data.gold)) : 1000;
    starFragments = Number.isFinite(data.starFragments) ? Math.max(0, Math.floor(data.starFragments)) : 0;
    totalDraws = Number.isFinite(data.totalDraws) ? Math.max(0, Math.floor(data.totalDraws)) : 0;
    swordStars = {};
    if (data.swordStars && typeof data.swordStars === 'object') {
      for (const key of Object.keys(data.swordStars)) {
        const idx = Number(key);
        const level = Math.floor(data.swordStars[key]);
        if (Number.isInteger(idx) && idx >= 0 && idx < SWORDS.length && Number.isFinite(level) && level > 0) {
          swordStars[idx] = Math.min(ENHANCE_MAX_STARS, level);
        }
      }
    }
  }

  function sumStudySecondsForDate(dateKey) {
    const day = studyByDate[dateKey];
    if (!day) return 0;
    return Object.values(day).reduce((a, b) => a + b, 0);
  }

  function sumStudySecondsRolling(days) {
    let total = 0;
    const todayK = studyDayKey();
    for (let i = 0; i < days; i++) total += sumStudySecondsForDate(addDays(todayK, -i));
    return total;
  }

  function sumStudySecondsAllTime() {
    let total = 0;
    for (const dateKey in studyByDate) total += sumStudySecondsForDate(dateKey);
    return total;
  }

  function leaderboardRow() {
    return {
      user_id: currentUserId,
      username: currentUsername,
      nickname: nickname || null,
      avatar,
      realm_level: realmLevel,
      sword_level: swordLevel,
      gold,
      study_today: sumStudySecondsForDate(studyDayKey()),
      study_week: sumStudySecondsRolling(7),
      study_month: sumStudySecondsRolling(30),
      total_draws: totalDraws,
      updated_at: new Date().toISOString(),
    };
  }

  async function flushSave() {
    if (!currentUserId) return;
    const [, { error: rankError }] = await Promise.all([
      sb.from('app_data').upsert({
        user_id: currentUserId,
        data: collectState(),
        updated_at: new Date().toISOString(),
      }),
      sb.from('leaderboard').upsert(leaderboardRow()),
    ]);
    // total_draws is a new column — until the matching migration has been
    // run, upserting it fails the whole row (not just that field), which
    // would otherwise silently stop gold/study time from reaching the
    // leaderboard too. Retry once without it so everything else still
    // syncs in the meantime.
    if (rankError) {
      const { total_draws, ...withoutTotalDraws } = leaderboardRow();
      await sb.from('leaderboard').upsert(withoutTotalDraws);
    }
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
    applyState(data && data.data ? data.data : {});
    // Always resync the leaderboard row on load, not just for brand-new
    // users: study_today/week/month are snapshots written by flushSave(),
    // so a device that was closed across the 5am study-day boundary and
    // reopened later would otherwise keep showing yesterday's number on
    // every ranking tab until some unrelated action happened to save.
    await flushSave();
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
  /* 오늘 공부시간만 자정이 아니라 오전 5시를 기준으로 리셋된다 — 자정부터
     새벽 4시 59분까지의 공부는 여전히 "어제"로 집계된다. 할 일/일정/연속
     달성일 등 나머지 날짜 개념은 그대로 자정 기준(todayKey)을 쓴다. */
  const studyDayKey = () => {
    const shifted = new Date();
    shifted.setHours(shifted.getHours() - 5);
    return toKey(startOfDay(shifted));
  };
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
  const incomePerMinute = el('incomePerMinute');
  const incomePerMinuteLabel = el('incomePerMinuteLabel');
  const incomePerHour = el('incomePerHour');
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
    enhance: el('panel-enhance'),
    codex: el('panel-codex'),
    epithet: el('panel-epithet'),
    profile: el('panel-profile'),
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
  const restDisplay = el('restDisplay');
  const measureBtn = el('measureBtn');
  const restBtn = el('restBtn');
  const checkinGate = el('checkinGate');
  const checkinText = el('checkinText');
  const checkinCountdown = el('checkinCountdown');
  const checkinYesBtn = el('checkinYesBtn');
  const adjustGate = el('adjustGate');
  const adjustMeasured = el('adjustMeasured');
  const adjustValue = el('adjustValue');
  const adjustRange = el('adjustRange');
  const adjustMax = el('adjustMax');
  const adjustReward = el('adjustReward');
  const adjustConfirmBtn = el('adjustConfirmBtn');
  const timerHint = el('timerHint');
  const todayTotalDisplay = el('todayTotalDisplay');
  const subjectBadge = el('subjectBadge');
  const subjectList = el('subjectList');
  const subjectEmpty = el('subjectEmpty');
  const subjectForm = el('subjectForm');
  const subjectTextInput = el('subjectText');
  const subjectItemTpl = el('subjectItemTemplate');

  const ladderRowTpl = el('ladderRowTemplate');

  const avatarCircle = el('avatarCircle');
  const avatarImg = el('avatarImg');
  const avatarPlaceholder = el('avatarPlaceholder');
  const avatarInput = el('avatarInput');
  const nicknameForm = el('nicknameForm');
  const nicknameInput = el('nicknameInput');
  const profileRealm = el('profileRealm');
  const profileSword = el('profileSword');
  const profileGold = el('profileGold');
  const profileTodayStudy = el('profileTodayStudy');
  const profileTotalStudy = el('profileTotalStudy');
  const profileStreak = el('profileStreak');
  const profileRankList = el('profileRankList');

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
      lore: '무공을 배우기 시작한 지 얼마 안 된 문파의 막내들이 이 반열에 속한다. 딱히 이름 붙일 정도의 경지도 아니라서, 강호인들은 이들을 그저 「초짜」라 부르며 눈여겨보지도 않는다.',
      desc: '내공이랄 것이 거의 없어 검을 몇 번 휘두르면 숨이 가빠오고, 초식은 스승이 시범 보인 동작을 어설프게 흉내 내는 수준이다. 그나마 익힌 것이라곤 기본 검법인 「목검삼식(木劍三式)」 정도뿐이며, 그마저도 자세가 흐트러지기 일쑤다. 이 시기의 유일한 무기는 지치지 않는 반복뿐이다.' },
    { name: '이류무사', hanja: '二流武士', price: 77000, studyBonus: 170,
      lore: '매일같이 반복한 초식이 비로소 몸에 붙기 시작하는 시기. 문파 내에서는 더 이상 완전한 초짜 취급을 받지 않지만, 강호 전체로 보면 여전히 셀 수 없이 많은 이들 중 하나일 뿐이다.',
      desc: '단전에 옅게나마 내공이 쌓여, 반 시진 정도는 숨이 크게 흐트러지지 않고 병기를 휘두를 수 있다. 기본 검법을 벗어나 문파의 정식 입문 무공인 「이류검결(二流劍訣)」을 배우기 시작하며, 상대의 다음 초식을 어렴풋이 예측하는 눈치가 트인다.' },
    { name: '일류무사', hanja: '一流武士', price: 207000, studyBonus: 230,
      lore: '정파 명문 문파의 후기지수들과 실력을 견줄 만하다고 평가받는 첫 관문. 이 경지부터는 마을 하나 정도는 혼자 지킬 수 있는 실력자로 인정받는다.',
      desc: '내공이 단전에 확실히 자리를 잡아, 한 시진 가까이 전력으로 몸을 쓸 수 있다. 경신법(輕身法)의 기초를 익혀 담장 정도는 가볍게 뛰어넘고, 문파의 대표 절기 중 하나를 정식으로 전수받아 「일류절초(一流絶招)」 한 수를 온전히 펼칠 수 있게 된다.' },
    { name: '절정 초입', hanja: '絶頂 初入', price: 419000, studyBonus: 310,
      lore: '내공이 단전에 완전히 뿌리내리며, 비로소 「고수」라는 말을 들을 자격이 생기는 문턱. 명문 대파에서는 이 경지에 이른 제자에게 정식 별호를 붙여주기 시작한다.',
      desc: '체내를 순환하는 내공을 스스로 감지하고 다스릴 수 있게 되어, 검에 옅은 예기(銳氣)를 실어 벨 수 있다. 절기의 초반 초식들을 완성하고, 「등평도수(登萍渡水)」의 기초를 익혀 물 위를 잠깐이나마 스칠 수 있다.' },
    { name: '절정 완숙', hanja: '絶頂 完熟', price: 756000, studyBonus: 420,
      lore: '다루는 무공이 물 흐르듯 자연스러워지는 시기. 한 지역, 한 문파를 대표하는 강자로 이름이 오르내리기 시작한다.',
      desc: '내공 운용이 능숙해져 검신 전체에 고르게 예기를 두를 수 있고, 절기를 처음부터 끝까지 막힘없이 펼친다. 「분광십삼검(分光十三劍)」류의 화려한 연속 초식을 구사하며, 하루 종일 싸워도 내공이 크게 마르지 않는다.' },
    { name: '절정 극', hanja: '絶頂 極', price: 1310000, studyBonus: 580,
      lore: '절정의 끝자락. 이때부터는 어엿한 「고수」로 불리며, 문파나 가문의 수장을 넘보는 위치에 선다.',
      desc: '여러 절기를 자유롭게 연계해 하나의 흐름으로 만들어내고, 검에 실은 예기가 뭉쳐 옅은 검기(劍氣)의 형태를 갖추기 시작한다. 절정의 정수를 담은 자신만의 절초 하나를 완성해, 강호에 이름 석 자를 알릴 만한 실력을 갖춘다.' },
    { name: '초절정 초입', hanja: '超絶頂 初入', price: 2160000, studyBonus: 800,
      lore: '구파일방과 천마신교의 장로 바로 아래 서열로 꼽히는 경지. 중원 전역에 이름이 알려지기 시작하며, 어딜 가든 함부로 대할 수 없는 존재가 된다.',
      desc: '검기를 자유자재로 뽑아내 병기 없이도 맨손에 두를 수 있고, 반로환동(返老還童)의 조짐이 나타나 몸이 젊어지듯 가벼워진다. 「어기충소(御氣衝宵)」로 삼 장 높이는 단숨에 뛰어오르며, 검기만으로 바위를 가른다.' },
    { name: '초절정 완숙', hanja: '超絶頂 完熟', price: 3470000, studyBonus: 1100,
      lore: '문주, 가주, 방주, 채주급의 실력으로 인정받는 경지. 단신으로 수십의 일류 고수를 상대할 수 있다는 평가를 받는다.',
      desc: '내공을 상대의 몸에 직접 흘려 넣는 격체전공(隔體傳功)이 가능해지고, 검기를 실처럼 가늘게 뽑아 원거리의 적을 벤다. 「초절정심법(超絶頂心法)」의 완숙한 운용으로 하루 밤낮을 꼬박 싸워도 지치지 않는다.' },
    { name: '초절정 극', hanja: '超絶頂 極', price: 5400000, studyBonus: 1500,
      lore: '초절정의 정점. 「초고수」라 불리며, 대문파의 장로 자리를 넘보는 실력자로 대접받는다.',
      desc: '검기의 강약과 형태를 뜻대로 조절해 한 초식으로 여럿을 동시에 벨 수 있고, 검강(劍罡)의 첫 조짐이 검신 위에 아지랑이처럼 어린다. 절정과 초절정의 모든 절기를 통합한 자신만의 성명절기를 완성한다.' },
    { name: '화경 초입', hanja: '化境 初入', price: 8100000, studyBonus: 2000,
      lore: '몸과 진기가 하나로 화(化)하기 시작하며, 어검(馭劍)의 실마리를 잡는 경지. 이때부터는 병기의 종류를 가리지 않고 다룬다는 말이 돈다.',
      desc: '검강을 온전히 뽑아내 어떤 병기도 종잇장처럼 갈라내고, 진기만으로 가까운 거리의 검을 손 없이 움직이는 이기어검(以氣馭劍)의 흉내를 낸다. 「허공답보(虛空踏步)」로 허공에 몇 걸음 디딜 수 있게 된다.' },
    { name: '화경 완숙', hanja: '化境 完熟', price: 12600000, studyBonus: 2800,
      lore: '천마신교 좌우 호법, 구파일방 장문인급으로 꼽히는 경지. 진기만으로 병기를 부린다는 소문이 과장이 아님을 증명하는 단계다.',
      desc: '이기어검을 자유자재로 구사해 검 여러 자루를 동시에 부리고, 검강의 형태와 색을 뜻대로 바꾸는 경지에 이른다. 「만검귀종(萬劍歸宗)」이라 불리는, 흩어졌던 검기가 하나로 모여 폭발하는 절기를 완성한다.' },
    { name: '화경 극', hanja: '化境 極', price: 18800000, studyBonus: 3800,
      lore: '화경의 정점. 삼대 세력 수뇌부와 어깨를 나란히 하는, 사실상 무림 최정상으로 꼽히는 자리다.',
      desc: '허공답보를 넘어 능공허도(凌空虛道)로 짧은 거리를 아예 날아서 이동하고, 진기를 형체 없이 뿜어내는 것만으로 주변의 살기를 짓누른다. 화경의 모든 성취를 하나로 꿴 궁극의 절기 하나를 완성해, 이후로는 「초고수」가 아니라 「대종사」로 불리기 시작한다.' },
    { name: '현경 초입', hanja: '炫境 初入', price: 28600000, studyBonus: 5300,
      lore: '생각이 곧 진기가 되어 눈부시게(炫) 빛나는 경지. 살아서는 닿기 힘들다던 벽 너머에 첫발을 디딘 존재들이다.',
      desc: '마음으로 떠올린 초식이 별도의 동작 없이 곧바로 검기로 화하는 심검(心劍)의 첫 단계에 이르고, 상대의 다음 수를 진기의 흐름만으로 미리 읽어낸다. 「이기어검」이 완전히 몸에 배어, 이제는 검을 뽑지 않고도 싸울 수 있다.' },
    { name: '현경 완숙', hanja: '炫境 完熟', price: 42100000, studyBonus: 7200,
      lore: '이기어검을 자유자재로 다루며, 존재 자체가 눈부신 빛으로 화하는 경지. 이 경지의 무인이 나타나면 그 자체로 강호에 파문이 인다.',
      desc: '심검을 완성해 검을 쥐지 않고도 눈빛만으로 벨 수 있다는 말이 돌고, 진기를 빛의 형태로 뿜어내 밤에도 그 존재를 감출 수 없다. 「현경만상(炫境萬象)」이라는, 진기만으로 주변 지형을 일시적으로 바꾸는 절기를 다룬다.' },
    { name: '현경 극', hanja: '炫境 極', price: 62400000, studyBonus: 9900,
      lore: '현경의 끝. 전설로만 회자되던 경지에 실제로 도달한 극소수의 존재로, 그 이름은 한 시대를 통째로 대표한다.',
      desc: '인간의 육체적 한계를 사실상 초월해, 한 초식의 검기가 산 하나를 가르는 광역 위력을 낸다. 현경의 모든 깨달음을 담은 자신만의 대성절기(大成絶技)를 완성하고, 이때부터 세간에서는 이들을 두고 「인간을 넘어선 무인」이라 부르기 시작한다.' },
    { name: '생사경 초입', hanja: '生死境 初入', price: 94500000, studyBonus: 14000,
      lore: '삶과 죽음의 경계를 손끝으로 다루기 시작하는, 죽어야만 넘볼 수 있다던 금단의 영역. 강호는 이 경지에 이른 이를 사람이 아니라 「경지 그 자체」로 부르기 시작한다.',
      desc: '치명상을 입어도 스스로 진기를 돌려 상처를 빠르게 아물리는 반쯤의 불사(不死)를 얻고, 검기에 생사의 기운을 실어 벤 자리에 시들거나 피어나는 흔적을 남긴다. 「생사현관(生死玄關)」을 넘나들며 죽음 직전까지 갔다가 되돌아오는 것으로 스스로를 단련한다.' },
    { name: '생사경 완숙', hanja: '生死境 完熟', price: 137000000, studyBonus: 19000,
      lore: '생과 사가 손안에서 하나가 된다. 존재만으로도 강호에 죽음의 그림자를 드리운다는 평가를 받는 경지다.',
      desc: '타인의 생명력을 진기의 형태로 빼앗거나 나눠주는 것이 가능해지고, 스스로의 수명 일부를 태워 순간적으로 현경 이상의 위력을 낼 수 있다. 「사자소생수(死者蘇生手)」라 불리는, 숨이 끊긴 지 얼마 안 된 자를 되살리는 금단의 수법을 다루는 이도 있다고 전해진다.' },
    { name: '생사경 극', hanja: '生死境 極', price: 191000000, studyBonus: 25000,
      lore: '생사경의 정점. 산 자의 몸으로 죽음 너머를 완전히 지배하는, 전설 속 인물의 경지로 여겨진다.',
      desc: '생사의 경계 자체를 자신의 영역으로 삼아, 검기가 스친 것은 생사를 뜻대로 오간다는 말이 돈다. 목숨을 걸지 않고도 생사경의 힘을 온전히 다룰 수 있게 되어, 비로소 이 경지의 완성자로 인정받는다.' },
    { name: '자연경 초입', hanja: '自然境 初入', price: 284000000, studyBonus: 35000,
      lore: '불로불사에 이르러 자연과 동화되기 시작하는, 인간의 굴레를 벗어난 신비의 경지. 이 경지부터는 나이를 묻는 것 자체가 무의미해진다.',
      desc: '몸의 노화가 사실상 멈추고, 주변의 바람과 물의 흐름을 거스르지 않고 그대로 몸에 실어 움직인다. 「자연조화수(自然造化手)」로 작은 나뭇가지 하나로도 절정 고수를 상대할 수 있는 경지에 이른다.' },
    { name: '자연경 완숙', hanja: '自然境 完熟', price: 410000000, studyBonus: 48000,
      lore: '천지의 기운과 완전히 하나가 되어, 늙지도 죽지도 않는 존재로 거듭나는 경지. 산속에 은거한 채 수백 년을 살았다는 전설의 주인공들이 대개 이 반열이다.',
      desc: '날씨와 지형의 흐름을 어렴풋이 감지해 미리 대비하고, 검을 뽑는 대신 주변의 초목과 바람을 무기 삼아 싸운다. 「풍운조화(風雲造化)」라 불리는, 국지적인 바람과 구름의 흐름을 잠시 바꾸는 절기를 다룬다.' },
    { name: '자연경 극', hanja: '自然境 極', price: 585000000, studyBonus: 65000,
      lore: '자연경의 정점. 스스로가 곧 자연의 일부가 되어, 더는 「인간」이라 부를 수 없는 존재로 여겨진다.',
      desc: '몸을 이루는 것이 살과 뼈보다는 천지의 기운에 가까워져, 웬만한 상처는 애초에 상처로 성립하지 않는다. 한 번의 손짓이 작은 재해에 준하는 위력을 내며, 강호는 이들을 더 이상 「무인」이 아니라 「경지의 화신」으로 기록한다.' },
    { name: '공허경 초입', hanja: '空虛境 初入', price: 851000000, studyBonus: 90000,
      lore: '우주의 이치를 어렴풋이 깨닫기 시작하는, 공(空)과 허(虛)의 경계에 선 경지. 이 경지에 이른 이들은 대개 강호를 떠나 종적을 감춘다.',
      desc: '공간의 이치를 어렴풋이 읽어, 「축지성촌(縮地成寸)」으로 먼 거리를 몇 걸음처럼 좁혀 이동한다. 진기가 형체를 완전히 벗어나, 존재를 감추면 기감이 예민한 고수조차 알아채지 못한다.' },
    { name: '공허경 완숙', hanja: '空虛境 完熟', price: 1218000000, studyBonus: 123000,
      lore: '우주의 지혜가 온전히 몸에 스며들어, 만물의 근원을 손바닥 위에 놓고 보는 경지. 이 반열에 이른 이는 살아있는 전설이 아니라 신화 속 존재로 취급받는다.',
      desc: '좁은 범위에서나마 공간을 접거나 늘리는 것이 가능해져, 「이형환위(移形換位)」로 순간적으로 자리를 바꿔 상대의 눈을 속인다. 만물의 이치를 손바닥 보듯 꿰뚫어, 상대의 무공 근원을 한눈에 파악한다.' },
    { name: '공허경 극', hanja: '空虛境 極', price: 1739000000, studyBonus: 168000,
      lore: '공허경의 정점. 텅 빈 듯하나 만물을 품은, 언어로는 형용할 수 없는 미지의 영역으로 전해진다.',
      desc: '공(空)과 허(虛) 그 자체와 하나가 되어, 존재를 지우듯 흔적 없이 일격을 가하는 「무형참(無形斬)」을 다룬다는 전설이 있다. 이 경지에 이른 이가 실제로 존재했는지조차 후대의 기록마다 엇갈린다.' },
    { name: '여의경 초입', hanja: '如意境 初入', price: 2484000000, studyBonus: 230000,
      lore: '뜻하는 대로 만물이 응하기 시작하는, 그 누구도 이르지 못했던 미지의 첫걸음. 강호의 역사서에도 「전설의 시작」 정도로만 기록되는 경지다.',
      desc: '떠올린 생각이 곧 진기의 흐름이 되어 주변 사물이 뜻대로 움직이기 시작하고, 「여의조화(如意造化)」로 작은 창조에 가까운 현상을 일으킨다. 이 단계부터는 무공이라는 말보다 「이치」라는 말이 더 어울린다는 평이 나온다.' },
    { name: '여의경 완숙', hanja: '如意境 完熟', price: 3555000000, studyBonus: 316000,
      lore: '무한한 의지(意志) 그 자체가 되어, 이치와 조화를 자유로이 넘나드는 경지. 실존 여부조차 구전으로만 전해지는 반열이다.',
      desc: '인과율의 아주 작은 자락을 스스로의 뜻으로 바꿔 쓰는 것이 가능해지며, 굳이 움직이지 않아도 뜻만으로 결과를 만들어낸다. 이쯤 되면 강호인들 사이에서도 「사람」인지 「이치」인지에 대한 논쟁이 벌어진다.' },
    { name: '여의경 극', hanja: '如意境 極', price: 5054000000, studyBonus: 432000,
      lore: '여의경의 정점이자 구도(求道)의 완성. 뜻이 곧 하늘이 되는, 더는 오를 곳이 없는 경지로 전해진다.',
      desc: '이르렀다는 사실 자체가 전설이 되는 경지. 이 반열에 도달한 이가 정말 존재했는지, 아니면 후대가 「도달할 수 있는 끝」을 상상해 만든 이야기인지는 아무도 알지 못한다. 강호 최후의 질문 — 「그 끝에는 무엇이 있는가」 — 에 대한 유일한 답으로 전해질 뿐이다.' }
  ];

  /* ---------------- Sword grades (검 등급) ----------------
     8 grades, probabilities fixed per grade — every sword inside a grade
     shares the exact same draw chance. Grade odds sum to 100 (범품's 0.5
     cut funds 용검's slice exactly, so nothing else moved).
     Naming follows a deliberate length ladder: 2 chars at 범품, 3 through
     the middle, back down to 2 for 용검 and the historical 신병이기, 선검
     breaks the ladder with a long name, and 설화검 — the final grade —
     returns to a short, weighty 3-character name befitting a closing
     legend. */
  const RARITIES = [
    { key: 'beompum',  name: '범품', hanja: '凡品', chance: 64.5 },
    { key: 'jeongpum', name: '정품', hanja: '精品', chance: 20 },
    { key: 'bogeom',   name: '보검', hanja: '寶劍', chance: 10 },
    { key: 'yeonggeom',name: '영검', hanja: '靈劍', chance: 4.8 },
    { key: 'yonggeom', name: '용검', hanja: '龍劍', chance: 0.5 },
    { key: 'sinbyeong',name: '신병이기', hanja: '神兵利器', chance: 0.175 },
    { key: 'seongeom', name: '선검', hanja: '仙劍', chance: 0.02 },
    { key: 'seolhwa',  name: '설화검', hanja: '說話劍', chance: 0.005 },
  ];

  /* ---------------- Sword pool (검 도감) ----------------
     Roughly weakest -> strongest by array position, but "which sword is
     the better blade" is decided by swordPower() (rarity first, then
     studyBonus) rather than raw array index — new entries for an
     already-shipped grade always get appended at the very end so an
     existing player's discovered/swordLevel indices never point at a
     different sword after an update, even when (as with 용검 below) the
     new grade sits lower in power than grades that were appended earlier.
     Within one grade the spread is kept inside 20%; between grades it is
     ~4.2x through 보검/영검, then a bigger but still capped ~8x into
     신병이기 and ~9x into 선검 — noticeably above the lower steps without
     ever handing a single pull more than roughly a 10x income multiplier. */
  const SWORDS = [
    /* ---- 범품(凡品) — 2자 ---- */
    { name: '목검', hanja: '木劍', rarity: 0, studyBonus: 1267,
      lore: '문파 입문 제자가 처음 손에 쥐는 수련용 검. 스승은 이것으로 삼 년을 휘두르게 한 뒤에야 쇠붙이를 내어준다. 한 노사(老師)는 제자가 이 나무검을 스무 번 부러뜨리기 전에는 진검 근처에도 오지 못하게 했다고 전해진다.',
      desc: '베는 검이 아니라 자세를 만드는 검. 모든 전설은 이 볼품없는 나무토막에서 시작된다. 쥐는 법, 딛는 법, 숨 고르는 법 — 강호의 모든 초식은 결국 이 한 자루로 돌아가 다시 배운다.' },
    { name: '단도', hanja: '短刀', rarity: 0, studyBonus: 1300,
      lore: '품에 넣고 다니기 좋게 한 뼘 남짓으로 벼려낸 짧은 칼. 무인보다 장사꾼과 뱃사람이 더 많이 찼다. 먼 길 떠나는 이들은 노잣돈과 함께 반드시 이 칼 한 자루를 챙겼다니, 그 쓰임은 무공보다 생계에 가까웠던 셈이다.',
      desc: '간격을 내줘야만 쓸 수 있다. 그래서 이 칼을 든 자는 늘 상대보다 한 걸음 더 들어가야 한다. 긴 병기를 상대할 때는 목숨을 걸어야 하지만, 그 한 걸음만 성공하면 승부는 순식간에 끝난다.' },
    { name: '환도', hanja: '環刀', rarity: 0, studyBonus: 1367,
      lore: '자루 끝에 고리를 달아 손목에 걸도록 만든 관병(官兵)의 제식 도. 병졸 하나하나에게 지급되던 물건이다. 전장에서 칼을 놓쳐도 손목의 고리 덕에 다시 주워 들 수 있었으니, 이름 없는 병사들의 목숨을 여럿 살린 병기다.',
      desc: '개인의 병기가 아니라 대오(隊伍)의 병기. 혼자 휘두르면 평범하나, 열이 함께 휘두르면 벽이 된다. 한 자루로는 하수의 칼이나, 백 자루가 나란히 서면 그 자체로 하나의 진법이 된다.' },
    { name: '철검', hanja: '鐵劍', rarity: 0, studyBonus: 1400,
      lore: '저잣거리 대장간에서 은자 두 냥이면 살 수 있는 양산품. 강호에 발을 들인 자의 열에 아홉은 이 검을 찬다. 명검을 노래하는 협객전 어디에도 이름이 오르내리지 않지만, 정작 첫걸음을 뗀 이들의 허리에는 예외 없이 이 검이 걸려 있었다.',
      desc: '투박하고 무겁고 잘 부러진다. 그럼에도 첫 애병으로 이 검을 기억하는 무사는 수없이 많다. 훗날 천하를 호령하게 된 고수들도, 술자리에서는 결국 이 흔한 철검 이야기로 첫 정을 나눈다.' },

    /* ---- 정품(精品) — 3자 ---- */
    { name: '유엽검', hanja: '柳葉劍', rarity: 1, studyBonus: 3133,
      lore: '버들잎을 본떠 검신을 얇고 길게 뽑아낸 검. 힘보다 결을 중히 여기는 남방 검파에서 즐겨 썼다. 봄바람에 흔들리는 버들가지처럼 검로가 유려하다 하여, 강남 규수들 사이에서도 호신용으로 인기가 높았다 전해진다.',
      desc: '무겁게 내리치는 검이 아니라 스치듯 흘려 베는 검. 상처는 얕지만, 그 얕은 것이 열 번 겹친다. 한 초식 한 초식은 위협적이지 않으나, 정신을 차렸을 땐 이미 수십 갈래의 잔상이 몸을 스쳐 지나간 뒤다.' },
    { name: '청류검', hanja: '靑流劍', rarity: 1, studyBonus: 3267,
      lore: '푸른 강철을 아홉 번 접어 두드려, 검신에 흐르는 물결 무늬가 그대로 남은 검. 대장장이는 아홉 번째 접음에서 손을 놓지 않으려 사흘 밤을 뜬눈으로 지새웠다고 하며, 그 집념이 검신의 물결무늬로 고스란히 남았다.',
      desc: '드디어 「부러지지 않는」 검을 손에 넣었다. 휘두르면 검로가 물길처럼 끊기지 않고 이어진다. 한 초식이 끝나기도 전에 다음 초식이 물처럼 스며드니, 상대는 어디서 한 초식이 끝나고 다음이 시작되는지조차 가늠하지 못한다.' },
    { name: '한상검', hanja: '寒霜劍', rarity: 1, studyBonus: 3400,
      lore: '북방의 찬 우물물로만 담금질을 마친 검. 칼집에 넣어두어도 검신에 서리가 옅게 맺힌다. 그 우물은 한겨울에도 얼지 않는다 하여 신물(神物) 취급을 받았고, 검을 담금질한 뒤로는 물빛마저 탁해져 다시는 쓸 수 없게 되었다는 이야기가 전한다.',
      desc: '뽑는 순간 손끝이 아릿하게 시리다. 베인 자리가 늦게 아프고, 늦게 피가 난다. 정작 무서운 건 상처가 아니라 그 뒤에 남는 한기 — 벤 자리는 오래도록 낫지 않고 시린 채로 남는다.' },
    { name: '부월검', hanja: '斧鉞劍', rarity: 1, studyBonus: 3533,
      lore: '도끼(斧)와 큰도끼(鉞)의 무게를 검의 형태에 옮겨 담은 중병(重兵). 팔 힘이 받쳐주지 않으면 오히려 짐이 된다. 본디 형벌 도구였던 부월의 위압감을 그대로 눌러 담았다 하여, 이 검을 처음 본 죄인들은 칼날보다 그 이름에 먼저 떨었다고 한다.',
      desc: '기교를 버리고 무게로 찍어 누르는 검. 막아낸 자의 병기가 먼저 부러지는 일이 잦다. 받아내는 쪽이 매번 손해를 보는 병기라, 이 검을 상대할 때는 아예 마주치지 않는 것이 최선의 초식으로 통한다.' },

    /* ---- 보검(寶劍) — 3자, 여기부터 별호(別號)가 붙는다 ---- */
    { name: '매화검', hanja: '梅花劍', rarity: 2, studyBonus: 6267, epithet: '매화검존의 후예',
      lore: '눈 속에서 홀로 피는 매화를 검리(劍理)로 삼은 명문의 보검. 검신에 다섯 꽃잎이 음각되어 있다. 개파조사 매화검존(梅花劍尊)이 설산 정상에서 홀로 만개한 매화 한 송이를 보고 깨우쳤다는 검리가, 오늘날까지 이 검신의 꽃잎 다섯 개로 남아 전해진다.',
      desc: '한 초식이 다섯 갈래로 흩어져 피어난다. 어느 꽃잎이 진짜 검끝인지 아무도 세어내지 못한다. 매화검존의 진전을 이었다고 인정받은 자만이 이 검을 오롯이 다룰 수 있다 하여, 쥐는 것만으로 절반은 그 이름을 빌리는 셈이다.' },
    { name: '빙혼검', hanja: '氷魂劍', rarity: 2, studyBonus: 6533, epithet: '빙혼선자의 재림',
      lore: '만년한옥(萬年寒玉)의 심(心)을 깎아 검신에 심었다는 극음(極陰)의 보검. 전설에 따르면 만년설산에서 좌화(坐化)한 빙혼선자(氷魂仙子)의 원혼이 그 옥심에 깃들었다 하여, 이 검을 오래 지닌 자는 체온마저 서서히 식어간다는 소문이 돈다.',
      desc: '스치기만 해도 상처가 얼어붙는다. 피 한 방울 흘리지 않고 상대를 쓰러뜨리는 서늘한 검. 칼날이 아니라 냉기로 승부를 가르는 검이라, 상대는 패배를 인정하기 전에 먼저 오한을 느낀다.' },
    { name: '복마검', hanja: '伏魔劍', rarity: 2, studyBonus: 6800, epithet: '복마검존의 금인',
      lore: '마(魔)를 엎드리게 한다는 뜻을 새겨, 정도(正道) 문파가 사악한 것을 벨 때만 뽑도록 봉인해 둔 보검. 칼집 자체에 진언(眞言)이 새겨져 있어, 사악한 기운을 품은 자가 억지로 뽑으려 하면 손끝이 타들어간다고 전해진다.',
      desc: '요사한 기운 앞에서 스스로 검명(劍鳴)을 낸다. 마물에게는 닿기도 전에 이미 두려운 검. 정작 이 검을 쥔 자보다 그 울음소리를 먼저 들은 마물이 달아나는 일이 더 잦다고들 한다.' },
    { name: '뇌정검', hanja: '雷霆劍', rarity: 2, studyBonus: 7067, epithet: '벽력검신',
      lore: '벼락 맞은 벽조목과 운철(隕鐵)을 함께 벼려낸 검. 뇌우가 몰아치는 날이면 스스로 울린다. 대장장이는 벼락이 내리치는 순간에 맞춰 담금질을 마쳐야 한다는 옛 비전을 따랐고, 그 탓에 아홉 번의 뇌우를 기다려서야 완성했다는 이야기가 전한다.',
      desc: '휘두를 때마다 천둥소리가 터진다. 소리가 곧 기세가 되어, 마주 선 자의 담을 먼저 부순다. 칼날이 닿기도 전에 그 울림만으로 전의를 꺾어버리니, 승부는 종종 검을 맞대기 전에 이미 끝나 있다.' },

    /* ---- 영검(靈劍) — 3자, 요검(妖劍) 계열 ---- */
    { name: '호아검', hanja: '虎牙劍', rarity: 3, studyBonus: 15000, epithet: '식인호의 재래',
      lore: '사람을 맛본 범의 어금니를 본떠 벼렸다는 요검. 쥔 자에게 짐승의 식욕(食慾)을 옮긴다. 검을 벼린 대장장이는 완성 직후 실성하여 산으로 들어갔고, 이후 그 산에서 사람을 습격하는 범이 유독 늘었다는 소문만이 남았다.',
      desc: '한 번 베면 두 번 베고 싶어진다. 검이 배고픈 것인지 주인이 배고픈 것인지, 곧 구분할 수 없게 된다. 칼집에 꽂아 두어도 은은한 허기가 가시지 않아, 이 검의 주인들은 하나같이 성정이 사나워졌다고 전해진다.' },
    { name: '악형검', hanja: '惡刑劍', rarity: 3, studyBonus: 16000, epithet: '형장귀검',
      lore: '죄인을 다스리던 형장(刑場)의 피를 천 번 먹은 검. 벌하는 쾌감(快感)이 그대로 검신에 배었다. 이 검을 쥐었던 형리(刑吏)들은 하나같이 임기를 채우지 못하고 자리에서 물러났는데, 벌하는 손이 스스로 멈추지 않았기 때문이라 한다.',
      desc: '이 검은 이기기 위해서가 아니라 벌하기 위해 움직인다. 쥔 자는 스스로를 늘 옳다고 믿게 된다. 정의와 광기의 경계가 흐려질 즈음이면, 이미 검이 주인의 손을 대신 움직이고 있다는 것을 알아챌 방법이 없다.' },
    { name: '겁멸검', hanja: '劫滅劍', rarity: 3, studyBonus: 17000, epithet: '만겁종언',
      lore: '겁(劫)이 다하면 만물이 스러진다는 이치를 억지로 검에 가둔 요검. 주인의 수명을 땔감으로 삼는다. 이 검을 만든 주술사는 완성과 동시에 백발이 되었다고 전해지며, 그 대가를 알고도 검을 세상에 내놓은 이유는 아무도 알지 못한다.',
      desc: '휘두른 만큼 주인의 날이 줄어든다. 그것을 알고도 놓지 못하는 것이, 이 검의 진짜 무서움이다. 쓰면 쓸수록 강해지지만 동시에 죽음에 가까워지니, 이 검을 오래 지닌 자를 강호는 반쯤 죽은 자라 불렀다.' },
    { name: '사흉검', hanja: '四凶劍', rarity: 3, studyBonus: 18000, epithet: '사흉재림',
      lore: '혼돈·궁기·도올·도철 네 흉수(四凶)의 성정을 한 자루에 봉인했다는 요검의 정점. 봉인을 새긴 도사는 넷 중 하나만 잘못 깨어나도 천하가 어지러워진다며, 검을 완성한 뒤 스스로 눈과 혀를 봉했다고 전해진다.',
      desc: '탐욕과 오만, 잔혹과 어리석음이 번갈아 주인을 부른다. 검을 이긴 자만이 검을 쓸 수 있다. 네 흉수의 목소리가 번갈아 속삭이니, 이 검의 진짜 주인은 검을 든 자가 아니라 그 속삭임에 굴복하지 않은 의지뿐이다.' },

    /* ---- 신병이기(神兵利器) — 2자, 구야자·간장의 신화 ---- */
    { name: '순구', hanja: '純鈞', rarity: 5, studyBonus: 119000, epithet: '무가지보',
      lore: '구야자(歐冶子)가 벼린 명검. 상감(相劍)의 명인 설촉은 이 검을 보고 「값을 매길 수 없다(無價之寶)」 하였다. 월왕은 이 검 하나를 위해 성 두 곳과 명마 천 필을 내놓겠다는 제안까지 받았으나, 끝내 손에서 놓지 않았다는 이야기가 전한다.',
      desc: '티 하나 없이 순수한 검. 화려한 기예가 없어도, 검 그 자체로 이미 완성되어 있다. 꾸밈으로 승부하는 검들 사이에서, 이 검만은 아무 수식 없이도 스스로 명검임을 증명한다.' },
    { name: '승사', hanja: '勝邪', rarity: 5, studyBonus: 122000, epithet: '벽사검혼',
      lore: '이름 그대로 사악함을 이긴다(勝邪)는 뜻을 얻은 구야자의 검. 완성되던 날 하늘에서 때아닌 우박이 쏟아졌는데, 사람들은 이를 사악한 것들이 검의 탄생을 두려워해 울부짖은 흔적이라 여겼다.',
      desc: '요사한 기운을 정면으로 눌러 없앤다. 베는 것이 아니라 굴복시키는 종류의 검. 다섯 자루 구야자의 명검 중에서도 유독 사악한 것들을 가려내는 눈이 밝다 하여, 오랫동안 사문(邪門) 색출에 쓰였다.' },
    { name: '어장', hanja: '魚腸', rarity: 5, studyBonus: 125000, epithet: '전제의 비수',
      lore: '물고기 뱃속에 감출 만큼 짧게 벼려진 비수. 전제(專諸)가 구운 생선 속에 숨겨 오왕 요(僚)를 시해한 그 검이다. 그날 이후 오나라 왕실은 생선 요리를 통째로 상에 올리는 것을 금했다 하며, 그 금기는 수백 년이 지나도록 이어졌다는 이야기가 전한다.',
      desc: '천하를 뒤집는 데 필요한 길이는 한 뼘이면 족했다. 짧기에 아무도 오는 것을 보지 못한다. 가장 짧은 검이 가장 큰 왕조의 운명을 갈랐다는 사실은, 강호에 병기의 크기와 위력이 무관함을 새삼 증명한다.' },
    { name: '거궐', hanja: '巨闕', rarity: 5, studyBonus: 128000, epithet: '파성패도',
      lore: '월왕 구천이 지녔다는 구야자의 검. 큰 궁궐(巨闕)의 문마저 갈라낸다 하여 그 이름을 얻었다. 실제로 궁궐 문을 벤 일화는 과장이라는 이들도 있으나, 이 검이 지나간 자리에 성한 병장기가 없었다는 기록만은 여러 문헌에서 공통된다.',
      desc: '섬세함을 논하지 않는다. 가로막은 것이 무엇이든, 그저 잘려 있을 뿐이다. 기교로 맞서려는 자들은 하나같이 병기가 먼저 두 동강 나는 것을 보고서야 이 검의 이름값을 이해했다.' },
    { name: '담로', hanja: '湛盧', rarity: 5, studyBonus: 131000, epithet: '택군이거',
      lore: '무도한 주인을 스스로 떠나 다른 나라의 어진 임금에게 갔다는 인의(仁義)의 검. 오왕 합려가 무도해지자 하룻밤 사이에 칼집에서 자취를 감추었고, 이후 초나라의 어진 임금 궁궐에서 다시 발견되었다는 전설이 전해진다.',
      desc: '이 검은 쥐는 자를 고른다. 자격이 없다고 판단되면, 어느 날 칼집만 남아 있다. 재물로도, 힘으로도 붙잡아 둘 수 없는 검이라, 강호인들은 이 검을 손에 넣기보다 이 검에게 선택받기를 바랐다.' },
    { name: '태아', hanja: '太阿', rarity: 5, studyBonus: 134000, epithet: '발검파군',
      lore: '구야자와 간장이 함께 벼린 위도(威道)의 검. 초나라가 포위되던 날, 성루에서 뽑아 든 것만으로 진나라 대군이 무너졌다 한다. 정작 칼날이 진나라 병사의 몸에 닿은 일은 단 한 번도 없었다고 하니, 그 위세만으로 전쟁의 승패를 가른 유일한 병기로 꼽힌다.',
      desc: '휘두르지 않아도 이긴다. 검을 뽑는 소리 하나가 이미 만 명의 전의를 꺾는다. 무인들 사이에서는 이 검을 두고 「싸우기 위해서가 아니라 싸움을 끝내기 위해 존재하는 검」이라 부른다.' },
    { name: '용천', hanja: '龍泉', rarity: 5, studyBonus: 137000, epithet: '잠룡승천',
      lore: '본래 이름은 용연(龍淵). 훗날 임금의 휘(諱)를 피해 용천으로 고쳐 부르게 되었다. 일곱 별의 형상이 검신에 어렸다 한다. 검신을 오래 들여다본 이들은 하나같이 그 안에서 승천을 기다리는 용의 눈을 보았다고 증언하나, 정작 그 용이 승천하는 것을 본 이는 아무도 없다.',
      desc: '들여다보면 깊은 못 속에 엎드린 용이 비친다. 물처럼 고요하다가, 한순간 승천한다. 평소엔 잔잔한 연못처럼 고요하지만, 일단 뽑히면 그 고요함이 곧 폭풍전야였음을 증명한다.' },
    { name: '막야', hanja: '莫邪', rarity: 5, studyBonus: 140000, epithet: '자검의 넋',
      lore: '쇠가 끝내 녹지 않자, 간장의 아내 막야가 스스로 화로에 몸을 던져 완성했다는 자검(雌劍). 완성된 검신에는 옅은 여인의 형상이 비친다는 소문이 돌았고, 강호인들은 차마 이 검을 함부로 매매하지 못했다 전해진다.',
      desc: '사람의 목숨 하나가 검이 되었다. 이 검이 우는 날은, 짝인 웅검이 가까이 있다는 뜻이다. 짝을 찾는 검명(劍鳴)이 구슬프다 하여, 이 검을 지닌 자는 밤마다 낮게 우는 소리를 들으며 잠들었다고 한다.' },
    { name: '간장', hanja: '干將', rarity: 5, studyBonus: 143000, epithet: '적자의 복수',
      lore: '명장 간장이 삼 년에 걸쳐 벼려낸 웅검(雄劍). 그는 이 검을 감추고 자검만을 왕에게 바쳤다가 목숨을 잃었다. 훗날 그의 아들이 장성하여 아비의 유언대로 감춰둔 이 검을 찾아내 원수를 갚았다는 이야기가, 강호에서 가장 널리 불리는 복수담으로 남아 있다.',
      desc: '주인의 원한을 대신 기억하는 검. 짝을 잃은 뒤로 늘 한쪽으로 조금 기울어 운다. 명검이 완성으로 끝나지 않고 대를 이어 원한을 완성했다는 점에서, 이 검은 병기이자 하나의 서사(敍事)로 통한다.' },

    /* ---- 선검(仙劍) ---- */
    { name: '천주멸신검', hanja: '天誅滅神劍', rarity: 6, studyBonus: 1070000, epithet: '신살의 뇌명',
      lore: '하늘이 직접 내리는 벌(天誅)을 형체로 굳힌 검. 사람을 베기 위한 물건이 아니라, 신을 멸(滅神)하기 위해 벼려졌다. 이 검이 처음 뽑힌 날 하늘이 사흘간 붉게 물들었다는 기록이 전해지며, 그 뒤로는 이 검을 논할 때 「누구를 벨 것인가」가 아니라 「무엇을 벨 자격이 있는가」를 먼저 물었다.',
      desc: '이 검 앞에서는 신위(神位)조차 필멸의 살덩이가 된다. 하늘의 이치로도 이 검날은 막지 못한다. 인세의 무공으로는 그 존재조차 가늠할 수 없어, 강호인들은 이 검을 두고 사람이 다룰 물건이 아니라고 입을 모은다.' },
    { name: '개벽조화검', hanja: '開闢造化劍', rarity: 6, studyBonus: 1280000, epithet: '창세의 검신',
      lore: '혼돈을 갈라 천지를 연(開闢) 그 최초의 일격이, 식지 않고 검의 형상으로 남은 것이라 전해진다. 세상에 아직 이름조차 없던 때의 검이라 하여, 이 검을 논하는 이들은 하나같이 「병기」가 아니라 「천지가 스스로를 새긴 흔적」이라 부른다.',
      desc: '베는 것이 아니라 짓는다(造化). 이 검이 그은 자리에는 없던 하늘과 없던 땅이 생겨난다. 파괴와 창조가 한 몸이라는 이치를 증명하듯, 이 검의 흔적이 지나간 자리는 폐허가 아니라 새로운 시작으로 남는다.' },

    /* ---- 웹소설 「광마회귀」 오마주 — 마교 오대명검 중 두 자루. 등급은
       영검(rarity 3)이지만, 기존 검들의 인덱스가 밀리면 이미 접속 중인
       유저들의 장착/도감 진행도가 엉뚱한 검을 가리키게 되므로 배열 맨
       끝에 덧붙인다 — 등급별 그룹핑은 배열 위치가 아니라 rarity 값으로
       이뤄지므로 게임 동작에는 차이가 없다. ---- */
    { name: '일살', hanja: '一殺', rarity: 3, studyBonus: 17200, epithet: '일도필살',
      lore: '마교 오대명검(五大名劍)의 하나로, 대대로 교 안에서 첫손에 꼽히는 살수(殺手)에게만 내려진다는 도(刀). 이름 그대로 「한 번에 하나를 벤다」는 뜻 외에는, 화려한 수식 하나 검신에 새기지 않았다.',
      desc: '긴 겨룸도 화려한 초식도 필요 없다. 이 칼을 뽑아 드는 순간 이미 승부는 정해져 있다는 말이 있을 만큼, 단 한 수로 모든 것을 끝내는 것을 첫째 이치로 삼는다.' },
    { name: '광명검', hanja: '光明劍', rarity: 3, studyBonus: 17600, epithet: '탈혼광명',
      lore: '마교 오대명검의 하나이자 광명좌사(光明左使)의 자리를 상징하던 신물. 어느 좌사가 진정한 마도(魔道)가 무엇인지 의문을 품고 교를 등지면서, 그 주인 또한 함께 강호를 떠났다고 전해진다.',
      desc: '검과 도로도 뚫지 못하는 몸을 내려주고, 마주한 자의 혼(魂)마저 거두어들인다는 무서운 신물. 정작 지금의 주인은 완전히 마(魔)에 잠식되는 것을 경계해, 이 검 대신 목검을 쥐고 처음부터 다시 수련한다는 이야기가 전해진다.' },

    /* ---- 설화검(說話劍) — 게임의 최종 등급. 강호에 전해지는 각종 웹소설
       속 신검들을 그대로 빌려와, 검 하나하나에 「전 주인이 어떻게 이
       검에 이르렀는가」라는 설화(說話)를 붙인다. 검신의 색은 하나같이
       칠흑처럼 검되, 그 위로 흰빛과 잿빛 사이의 광택이 물결치듯 흐른다
       (.rar-6 참고) — 다마스커스 강처럼, 검이 아니라 그 자체로 하나의
       전설임을 새긴 무늬다. ---- */
    { name: '파천검', hanja: '破天劍', rarity: 7, studyBonus: 2333333, epithet: '천 번의 결말',
      lore: '몇 번이고 되풀이된 세계의 끝에서, 단 한 사람만이 매번 다른 검을 들고 살아 돌아왔다는 이야기가 전해진다. 그가 마지막 회차에 이르러서야 완성했다는 이 검은, 하늘이 정해둔 결말(結末)조차 그은 자리대로 다시 쓴다 하여 파천(破天)이라는 이름을 얻었다.',
      desc: '이 검 앞에서는 「이미 정해진 미래」라는 말이 무의미해진다. 몇 번을 다시 살아도 바뀌지 않던 결말을, 단 한 번의 발검으로 부숴버린다는 전설의 검.' },
    { name: '진천패도', hanja: '震天覇刀', rarity: 7, studyBonus: 2466667, epithet: '패왕의 진노',
      lore: '패도(覇道)를 논하는 자들 사이에서 정점으로 꼽히던 무인이 지녔다는 도(刀). 휘두를 때마다 뇌성이 울려 하늘을 뒤흔들었다 하여 진천(震天)이라는 이름이 붙었으며, 그가 세상을 등진 뒤로는 아무도 그 무게를 온전히 감당하지 못했다고 전해진다.',
      desc: '패기(覇氣) 하나만으로 산을 가르고 강을 뒤집는다는 도. 정교한 초식보다 압도적인 힘으로 모든 것을 짓누르는, 패도 무공의 정수를 담은 병기다.' },
    { name: '송문고검', hanja: '松紋古劍', rarity: 7, studyBonus: 2600000, epithet: '태극의 근본',
      lore: '무당파 개파조사가 무당산 소나무 아래에서 도를 깨우친 뒤, 그 소나무의 결(松紋)을 그대로 검신에 새겨 벼렸다는 전설의 고검. 몇 대에 걸쳐 장문인에게만 전해지다, 어느 대에 이르러 홀연히 자취를 감췄다고 전한다.',
      desc: '부드러움으로 강함을 이기는 태극(太極)의 이치를 그대로 담은 검. 검신을 타고 흐르는 물결무늬가 유(柔)와 강(剛)이 본디 하나임을 말없이 증명한다.' },
    { name: '암향매화검', hanja: '暗香梅花劍', rarity: 7, studyBonus: 2733333, epithet: '그윽한 향, 소리없는 참격',
      lore: '매화검존(梅花劍尊)이 생애 마지막으로 완성했다는 검. 향(香)이 먼저 스미고 검은 그 뒤에 닿는다 하여 암향(暗香)이라는 이름이 붙었으며, 검존이 스러진 뒤로는 그 진전을 온전히 이은 자가 다시 나타나기까지 백 년이 걸렸다고 전해진다.',
      desc: '매화 향이 코끝에 닿는 순간이면 이미 승부는 끝나 있다. 보이지 않고 들리지 않는 참격이야말로 검존이 다다른 마지막 경지였다는 이야기가 강호에 전한다.' },
    { name: '창천검', hanja: '蒼天劍', rarity: 7, studyBonus: 2866667, epithet: '푸른 하늘의 검',
      lore: '오대세가 중 검으로 이름난 남궁세가에서 대대로 가주에게만 전해진다는 보검. 창천(蒼天)이라는 이름은 이 검을 뽑아 든 가주의 검기가 맑은 날의 하늘빛을 닮았다는 데서 왔다고 전해진다.',
      desc: '제왕검형(帝王劍形)의 정수를 담아, 한 초식 한 초식에 창공을 가르는 듯한 웅혼함이 서려 있다. 세가의 위엄이 검 한 자루에 고스란히 응축되어 있다는 평을 듣는다.' },
    { name: '사일검', hanja: '射日劍', rarity: 7, studyBonus: 3000000, epithet: '태양을 쏘아 떨어뜨리다',
      lore: '아홉 개의 태양을 활로 쏘아 떨어뜨렸다는 전설의 궁사(弓射)를 검으로 옮겼다는 점창파의 신검. 검 끝에서 뻗어나가는 검기가 마치 화살처럼 곧게 쏘아진다 하여 사일(射日)이라는 이름을 얻었다.',
      desc: '곧고 빠르기가 화살과 같아, 한 번 뻗은 검기는 거두어들일 수 없다. 점창파 검법의 정화(精華)로 꼽히며, 이 검을 완성한 자는 강호에 손에 꼽힐 정도라고 전한다.' },
    { name: '반야멸마검', hanja: '般若滅魔劍', rarity: 7, studyBonus: 3166667, epithet: '지혜로 마를 베다',
      lore: '속세를 떠난 노승이 평생의 깨달음을 검 한 자루에 담아 냈다는 신검. 반야(般若)의 지혜로 마성(魔性)을 벤다 하여 반야멸마(般若滅魔)라는 이름이 붙었으며, 완성된 뒤로 그 노승은 검을 남기고 홀연히 열반(涅槃)에 들었다고 전해진다.',
      desc: '칼날보다 먼저 마음을 벤다는 검. 사특한 기운을 품은 자는 이 검 앞에 서는 것만으로 스스로 무너진다고 하여, 마(魔)를 다루는 자들이 가장 두려워하는 신검으로 꼽힌다.' },
    { name: '패왕단혼검', hanja: '霸王斷魂劍', rarity: 7, studyBonus: 3333333, epithet: '혼을 끊는 패왕의 검',
      lore: '오대세가 중 가장 오랜 역사를 자랑하는 황보세가의 진산지보(鎭山之寶). 역대 최강으로 꼽히던 가주가 필생의 공력을 쏟아 완성했다는 이 검은, 닿는 순간 육신이 아니라 혼(魂)을 끊어놓는다 하여 단혼(斷魂)이라는 이름이 붙었다.',
      desc: '패왕(霸王)의 이름에 걸맞게, 이 검 앞에서는 어떤 방어도 무의미하다는 말이 전해진다. 오대세가 최후의 병기이자, 강호 전체를 통틀어도 손에 꼽히는 신위(神威)를 지녔다고 알려져 있다.' },

    /* ---- 용검(龍劍) — 영검과 신병이기 사이에 새로 생긴 등급. 동서남북중
       오방(五方)을 지킨다는 오방신룡(五方神龍) 전설을 그대로 검 다섯 자루에
       옮겨, 각 검신에 그 방위를 지키는 용의 빛깔과 숨결을 담았다. ---- */
    { name: '청룡검', hanja: '靑龍劍', rarity: 4, studyBonus: 33333, epithet: '동녘을 여는 첫 울음',
      lore: '동해 깊은 곳에서 천 년을 몸을 사린 끝에 여의주를 얻어 승천했다는 청룡의 발톱을 본떠 벼린 검. 검을 벼리던 날 동쪽 하늘이 사흘 밤낮 푸르게 밝았다 하여, 그 빛을 그대로 검신에 새겨 넣었다고 전해진다.',
      desc: '검을 뽑으면 봄바람과 함께 옅은 물비린내가 실려 온다는 검. 베는 순간 검신을 타고 오르는 푸른 기운이, 마치 용이 다시 한번 승천하려는 것처럼 요동친다.' },
    { name: '백룡검', hanja: '白龍劍', rarity: 4, studyBonus: 36667, epithet: '서쪽 하늘의 서릿발',
      lore: '만년설산 정상에서 눈보라만 먹고 산다는 백룡의 비늘 한 조각을 심(心)으로 삼아 벼린 검. 백룡은 좀처럼 인세에 모습을 드러내지 않아, 이 비늘을 얻은 대장장이조차 끝내 그 실체를 보지 못했다고 전한다.',
      desc: '칼날이 지나간 자리엔 옅은 서릿발이 맺힌다. 소리 없이 다가와 숨통을 끊는다는, 가을 서풍처럼 조용하고 차가운 검.' },
    { name: '적룡검', hanja: '赤龍劍', rarity: 4, studyBonus: 40000, epithet: '타오르는 남쪽의 심장',
      lore: '화산 심연에서 억겁의 세월 마그마를 삼키며 몸을 불린 적룡의 심장 한 조각을 벼려낸 검. 완성되던 순간 대장간 전체가 불길에 휩싸였으나, 정작 검신은 조금도 그을리지 않았다고 전해진다.',
      desc: '쥐는 순간 손끝부터 열기가 차오른다. 벤 자리에서 불길이 솟는다는 소문 때문에, 이 검을 상대한 이들은 상처보다 화상을 먼저 두려워했다.' },
    { name: '흑룡검', hanja: '黑龍劍', rarity: 4, studyBonus: 43333, epithet: '심연을 삼킨 어둠',
      lore: '빛조차 닿지 않는 북해 심연에 똬리를 틀고 있다는 흑룡의 발톱으로 벼린 검. 흑룡을 본 자는 살아 돌아오지 못한다는 오랜 금기 때문에, 이 검이 어떻게 세상에 나왔는지는 아무도 알지 못한다.',
      desc: '검신이 빛을 삼켜, 뽑아도 번뜩임이 없다. 상대는 검이 다가오는 것을 보지 못한 채, 이미 베인 뒤에야 그 존재를 깨닫는다.' },
    { name: '황룡검', hanja: '黃龍劍', rarity: 4, studyBonus: 46667, epithet: '천하를 굽어보는 눈',
      lore: '동서남북 네 용을 거느리고 천지의 중심에 좌정했다는 황룡의 뿔로 벼린 검. 옛 왕조들은 이 검을 지닌 자야말로 하늘의 뜻을 받든 진정한 주인이라 여겨, 서로 손에 넣으려 다투었다고 전해진다.',
      desc: '이 검을 든 자 앞에서는 나머지 네 방위의 기운마저 숨을 죽인다. 다스리기 위한 검이지, 베기 위한 검이 아니다.' },
  ];

  /* ---------------- 강화 (검 개별 강화) ----------------
     Drawing a sword you've already discovered gives 별의 조각 instead of
     nothing — the amount scales with the duplicate's own rarity. Spend
     them in the 강화 tab to push an individually-owned sword's star level
     up, 1★ at a time, capped at 10★, and the odds get worse the higher
     the star level already is — a failed attempt just burns the
     fragments spent, the star level never drops. Each successful step
     adds its own income bonus (stacking multiplicatively with nothing
     else): a flat +3% for 1-5★, then a bigger jump per star from 6★
     onward (+4/6/8/10/12%) so pushing into the top stars is a genuinely
     stronger payoff, not just a flatter continuation of the early ones. */
  const STAR_FRAGMENTS_BY_RARITY = [1, 2, 5, 12, 22, 40, 150, 500];
  const ENHANCE_MAX_STARS = 10;
  // index = star level being reached (0 -> 1★, ... 9 -> 10★).
  const ENHANCE_BONUS_BY_STAR = [0.03, 0.03, 0.03, 0.03, 0.03, 0.04, 0.06, 0.08, 0.10, 0.12];
  // index = current star count (0-10) -> total multiplier bonus at that level.
  const ENHANCE_TOTAL_BONUS_BY_STAR = ENHANCE_BONUS_BY_STAR.reduce(
    (acc, bonus) => [...acc, acc[acc.length - 1] + bonus],
    [0],
  );
  // index = current star level before the attempt (0 -> level 1, ... 9 -> level 10).
  // 범품~영검 (rarity 0-3) all share one flat, near-free cost table -- their
  // income is tiny, so the 별의 조각 cost has to stay tiny too, or the
  // investment dwarfs the payoff ("배보다 배꼽이 커짐"). 용검/신병이기/선검
  // (rarity 4-6) keep the original scaled formula, since they're genuine
  // end-game gear where a bigger investment is expected.
  const ENHANCE_LOW_TIER_COST_BY_LEVEL = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
  const ENHANCE_COST_BY_LEVEL = [4, 7, 11, 17, 26, 40, 62, 100, 160, 260];
  const ENHANCE_CHANCE_BY_LEVEL = [95, 90, 85, 78, 70, 60, 48, 35, 22, 12];
  const ENHANCE_RARITY_COST_MULT = [1, 1, 1, 1, 2, 3, 4.5, 6.75]; // 0-3 unused, see enhanceCostFor
  const ENHANCE_RARITY_CHANCE_MULT = [1, 0.96, 0.9, 0.82, 0.78, 0.7, 0.55, 0.43];
  const ENHANCE_MIN_CHANCE = 5;

  // Grade first, studyBonus as the tiebreaker within a grade — used instead
  // of raw array index to decide "is this sword actually stronger", since
  // grades appended later (용검, 설화검) don't sit at array positions that
  // match their power (see the SWORDS comment above).
  function swordPower(idx) {
    const s = SWORDS[idx];
    return s.rarity * 1e9 + s.studyBonus;
  }

  function enhanceCostFor(swordIdx, stars) {
    const rarity = SWORDS[swordIdx].rarity;
    if (rarity <= 3) return ENHANCE_LOW_TIER_COST_BY_LEVEL[stars];
    return Math.round(ENHANCE_COST_BY_LEVEL[stars] * ENHANCE_RARITY_COST_MULT[rarity]);
  }
  function enhanceChanceFor(swordIdx, stars) {
    const raw = ENHANCE_CHANCE_BY_LEVEL[stars] * ENHANCE_RARITY_CHANCE_MULT[SWORDS[swordIdx].rarity];
    return Math.max(ENHANCE_MIN_CHANCE, Math.round(raw));
  }

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

    // Spell the sum out on the label so the three tabs visibly reconcile:
    // 경지 효율 + 검 효율 = this number.
    const realmPart = realmIncomeAt(realmLevel);
    const swordPart = swordIncomeAt(swordLevel);
    const total = realmPart + swordPart;
    incomePerMinute.textContent = `${total.toLocaleString('ko-KR')}G`;
    incomePerMinuteLabel.textContent =
      `총 분당 골드 (경지 ${realmPart.toLocaleString('ko-KR')} + 검 ${swordPart.toLocaleString('ko-KR')})`;
    incomePerHour.textContent = `${(total * 60).toLocaleString('ko-KR')}G`;
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

  function niceGold(n) {
    if (n < 100) return Math.round(n / 5) * 5;
    if (n < 1000) return Math.round(n / 10) * 10;
    if (n < 10000) return Math.round(n / 100) * 100;
    if (n < 1000000) return Math.round(n / 1000) * 1000;
    if (n < 100000000) return Math.round(n / 100000) * 100000;
    return Math.round(n / 1000000) * 1000000;
  }

  /* ---------------- Tabs ---------------- */
  function switchTab(name) {
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
    Object.entries(tabPanels).forEach(([key, panel]) => panel.classList.toggle('active', key === name));
    if (name === 'ranking') renderRanking(currentRankCategory);
    if (name === 'enhance') renderEnhance();
    if (name === 'codex') renderCodex();
    if (name === 'epithet') renderEpithets();
    if (name === 'profile') renderProfile();
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ---------------- Ranking ---------------- */
  const RANK_CATEGORIES = {
    realm: { column: 'realm_level', label: (v) => (REALMS[v] ? `${REALMS[v].name} (${REALMS[v].hanja})` : '-') },
    sword: {
      column: 'sword_level',
      label: (v) => (SWORDS[v] ? `[${RARITIES[SWORDS[v].rarity].name}] ${SWORDS[v].name}` : '-'),
    },
    gold: { column: 'gold', label: (v) => `${(v || 0).toLocaleString('ko-KR')}G` },
    study_today: { column: 'study_today', label: (v) => formatDurationLabel(v || 0) },
    study_week: { column: 'study_week', label: (v) => formatDurationLabel(v || 0) },
    study_month: { column: 'study_month', label: (v) => formatDurationLabel(v || 0) },
    total_draws: { column: 'total_draws', label: (v) => `${(v || 0).toLocaleString('ko-KR')}회` },
  };
  const RANK_LABELS = {
    realm: '🧘 경지', sword: '⚔️ 검', gold: '🪙 골드',
    study_today: '☀️ 오늘 공부', study_week: '📅 최근 7일', study_month: '🗓️ 최근 30일',
    total_draws: '🎲 총 뽑기',
  };
  let currentRankCategory = 'realm';

  async function renderRanking(category) {
    currentRankCategory = category;
    rankCategoryButtons.forEach((b) => b.classList.toggle('active', b.dataset.cat === category));
    const cfg = RANK_CATEGORIES[category];

    // Named columns, not '*' -- keeps updated_at and anything added later out
    // of a query that already runs often and carries an avatar per row.
    let { data, error } = await sb
      .from('leaderboard')
      .select('user_id, username, nickname, avatar, realm_level, sword_level, gold, study_today, study_week, study_month, total_draws')
      .order(cfg.column, { ascending: false })
      .limit(200);

    // total_draws is a new column -- until its migration has run, asking
    // for it errors the whole query (not just that field), which would
    // otherwise blank out every ranking category, not just this one. Fall
    // back to the older column list rather than showing nothing.
    if (error) {
      ({ data, error } = await sb
        .from('leaderboard')
        .select('user_id, username, nickname, avatar, realm_level, sword_level, gold, study_today, study_week, study_month')
        .order(cfg.column, { ascending: false })
        .limit(200));
    }

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
      // A user who has set a nickname shows only their photo + nickname on
      // the board, never their login id; without one it falls back to id.
      // Every field here comes straight from someone else's row, which
      // this app never fully controls (see isSafeAvatarUrl above) — the
      // nickname is safe as plain text via textContent, but still capped
      // here so a bypassed-client oversized string can't blow out the
      // row layout for everyone looking at the board.
      node.querySelector('.rank-username').textContent = (row.nickname || row.username || '익명').slice(0, 24);
      const avatarEl = node.querySelector('.rank-avatar');
      if (isSafeAvatarUrl(row.avatar)) {
        avatarEl.style.backgroundImage = `url(${row.avatar})`;
      } else {
        avatarEl.textContent = (row.nickname || row.username || '?').trim().charAt(0).toUpperCase();
      }
      node.querySelector('.rank-value').textContent = cfg.label(row[cfg.column]);
      rankList.appendChild(node);
    });
  }

  rankCategoryButtons.forEach((btn) => btn.addEventListener('click', () => renderRanking(btn.dataset.cat)));

  /* ---------------- Profile (프로필) ---------------- */
  // Small on purpose: this rides along in every row of every leaderboard
  // fetch (up to 200 rows at a time), so its size multiplies by however
  // many people are looking at the board at once.
  const MAX_AVATAR_DIM = 96;
  const AVATAR_MAX_BYTES = 24 * 1024;

  function renderAvatar() {
    if (avatar) {
      avatarImg.src = avatar;
      avatarImg.hidden = false;
      avatarPlaceholder.hidden = true;
    } else {
      avatarImg.hidden = true;
      avatarPlaceholder.hidden = false;
    }
  }

  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files && avatarInput.files[0];
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    img.onload = () => {
      // Cover-crop to a square, then downscale — keeps every stored avatar
      // small since it rides along in every leaderboard row fetched.
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = MAX_AVATAR_DIM;
      canvas.height = MAX_AVATAR_DIM;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, side, side, 0, 0, MAX_AVATAR_DIM, MAX_AVATAR_DIM);
      // Step quality down further for an unusually detailed/noisy photo
      // rather than shipping a leaderboard-row outlier several times the
      // size of everyone else's.
      let quality = 0.65;
      let dataUrl = canvas.toDataURL('image/jpeg', quality);
      while (dataUrl.length > AVATAR_MAX_BYTES && quality > 0.3) {
        quality -= 0.15;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      avatar = dataUrl;
      renderAvatar();
      queueSave();
      showToast('🙂 프로필 사진을 저장했어요.');
    };
    reader.readAsDataURL(file);
    avatarInput.value = '';
  });

  nicknameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    nickname = nicknameInput.value.trim().slice(0, 16);
    nicknameInput.value = nickname;
    queueSave();
    showToast(nickname ? `✏️ 닉네임을 "${nickname}"(으)로 저장했어요.` : '✏️ 닉네임을 지웠어요.');
  });

  async function renderProfile() {
    renderAvatar();
    nicknameInput.value = nickname;

    // 경지/검 borrow the exact tier/rarity treatment their own tabs use;
    // the rest get a neutral glossy shine since they have no tier color.
    const cur = REALMS[realmLevel];
    profileRealm.textContent = `${cur.name} (${cur.hanja})`;
    profileRealm.className = `profile-stat-value cultivation-name tier-${tierOf(realmLevel)}`;

    const curSword = SWORDS[swordLevel];
    profileSword.textContent = `[${RARITIES[curSword.rarity].name}] ${curSword.name}`;
    profileSword.className = `profile-stat-value cultivation-name rar-${curSword.rarity}`;

    profileGold.textContent = `${gold.toLocaleString('ko-KR')}G`;
    profileGold.className = 'profile-stat-value stat-shine';

    profileTodayStudy.textContent = formatDurationLabel(sumStudySecondsForDate(studyDayKey()));
    profileTodayStudy.className = 'profile-stat-value stat-shine';

    profileTotalStudy.textContent = formatDurationLabel(sumStudySecondsAllTime());
    profileTotalStudy.className = 'profile-stat-value stat-shine';

    profileStreak.textContent = `${computeStreak()}일`;
    profileStreak.className = 'profile-stat-value stat-shine';

    profileRankList.innerHTML = '';
    const entries = Object.entries(RANK_CATEGORIES);
    const results = await Promise.all(entries.map(([, cfg]) =>
      sb.from('leaderboard').select('user_id').order(cfg.column, { ascending: false }).limit(200)
    ));
    entries.forEach(([key], i) => {
      const { data, error } = results[i];
      const rows = error ? [] : (data || []);
      const idx = rows.findIndex((r) => r.user_id === currentUserId);
      const li = document.createElement('li');
      li.className = 'profile-rank-row';
      const label = RANK_LABELS[key] || key;
      li.innerHTML = `<span class="profile-rank-label">${label}</span><span class="profile-rank-place">${idx >= 0 ? `${idx + 1}위` : '순위 없음'}</span>`;
      profileRankList.appendChild(li);
    });
  }

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
    const todayK = studyDayKey();
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
      renderRest();
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
    renderRest();
  }

  function renderRest() {
    if (!activeSession || activeSession.endTs) {
      restBtn.classList.add('hidden');
      restDisplay.classList.add('hidden');
      restBtn.classList.remove('resting');
      return;
    }
    restBtn.classList.remove('hidden');
    restDisplay.classList.remove('hidden');
    const resting = !!activeSession.restStartTs;
    restBtn.textContent = resting ? '▶ 그만 쉬기' : '☕ 쉬기';
    restBtn.classList.toggle('resting', resting);
    restDisplay.textContent = `쉰 시간 ${formatDuration(restElapsed(activeSession))}`;
  }

  /* ---------------- Anti-idle check-in ----------------
     A running measurement asks "공부하고 있나요?" every 3 hours. Miss the
     answer for an hour and the whole measurement is voided, so a timer left
     running unattended banks nothing.

     Both deadlines are derived from startTs and a confirmed counter rather
     than from timers, so closing the tab or reloading cannot dodge a
     check-in: the state is recomputed from the clock on every tick and on
     restore. */
  const CHECKIN_EVERY_MS = 3 * 60 * 60 * 1000;
  const CHECKIN_GRACE_MS = 60 * 60 * 1000;

  const checkinDueAt = (s) => s.startTs + CHECKIN_EVERY_MS * ((s.confirmed || 0) + 1);
  const checkinDeadlineAt = (s) => checkinDueAt(s) + CHECKIN_GRACE_MS;
  // Total time spent on a break: past breaks plus the one in progress, if any.
  // Subtracted out of sessionElapsed so resting never counts as studying.
  const restElapsedMs = (s) => {
    const doneMs = (s.restSeconds || 0) * 1000;
    const currentMs = s.restStartTs ? Date.now() - s.restStartTs : 0;
    return doneMs + currentMs;
  };
  const restElapsed = (s) => Math.floor(restElapsedMs(s) / 1000);
  // Folds an in-progress break into restSeconds and clears restStartTs, so
  // whatever reads restElapsedMs next (a freeze on stop, or just resuming
  // the study clock) sees a consistent, no-longer-ticking rest duration.
  function endRestIfAny(s) {
    if (!s.restStartTs) return;
    s.restSeconds = (s.restSeconds || 0) + Math.floor((Date.now() - s.restStartTs) / 1000);
    s.restStartTs = null;
  }
  // Subtracting in milliseconds before the single final floor keeps the
  // displayed study time perfectly frozen for the whole break -- flooring
  // the raw elapsed and the rest elapsed separately (each anchored at a
  // different start time) would drift by a second here and there.
  const sessionElapsed = (s) => Math.max(0, Math.floor((((s.endTs || Date.now()) - s.startTs) - restElapsedMs(s)) / 1000));

  function hideCheckin() { checkinGate.classList.add('hidden'); }

  function renderCheckin(now) {
    if (!activeSession || activeSession.endTs || now < checkinDueAt(activeSession)) {
      hideCheckin();
      return;
    }
    const hours = Math.round(CHECKIN_EVERY_MS * ((activeSession.confirmed || 0) + 1) / 3600000);
    checkinText.textContent = `측정을 시작한 지 ${hours}시간이 지났어요. 아직 공부 중이라면 아래 버튼을 눌러주세요.`;
    const left = Math.max(0, checkinDeadlineAt(activeSession) - now);
    checkinCountdown.textContent = `남은 시간 ${formatDuration(Math.floor(left / 1000))}`;
    checkinGate.classList.remove('hidden');
  }

  function voidSession() {
    if (!activeSession) return;
    const subj = subjects.find((s) => s.id === activeSession.subjectId);
    clearInterval(tickInterval);
    tickInterval = null;
    activeSession = null;
    hideCheckin();
    adjustGate.classList.add('hidden');
    queueSave();
    renderSubjects();
    renderTimerUI();
    renderTodayTotal();
    showToast(`🚫 1시간 동안 응답이 없어 ${subj ? subj.name : '이번'} 측정이 무효 처리됐어요.`);
  }

  checkinYesBtn.addEventListener('click', () => {
    if (!activeSession || activeSession.endTs) return;
    const now = Date.now();
    if (now >= checkinDeadlineAt(activeSession)) { voidSession(); return; }
    while (now >= checkinDueAt(activeSession)) {
      activeSession.confirmed = (activeSession.confirmed || 0) + 1;
    }
    queueSave();
    hideCheckin();
    showToast('✅ 확인했어요. 계속 집중해봐요!');
  });

  function tick() {
    if (!activeSession || activeSession.endTs) return;
    const now = Date.now();
    if (now >= checkinDeadlineAt(activeSession)) { voidSession(); return; }
    timerDisplay.textContent = formatDuration(sessionElapsed(activeSession));
    renderRest();
    renderTodayTotal();
    renderCheckin(now);
  }

  function renderTodayTotal() {
    let total = sumStudySecondsForDate(studyDayKey());
    if (activeSession) total += sessionElapsed(activeSession);
    todayTotalDisplay.textContent = formatDuration(total);
  }

  function startTicking() {
    if (tickInterval) clearInterval(tickInterval);
    tick();
    tickInterval = setInterval(tick, 1000);
  }

  /* Restores whatever the saved session was mid-way through: a measurement
     already past its grace window is voided on the spot, one waiting on the
     end-of-session adjustment reopens that dialog, anything else resumes. */
  function resumeSession() {
    if (!activeSession) return;
    if (activeSession.endTs) { openAdjust(); return; }
    if (Date.now() >= checkinDeadlineAt(activeSession)) { voidSession(); return; }
    startTicking();
  }

  function startTimer(subjectId) {
    activeSession = { subjectId, startTs: Date.now(), confirmed: 0, endTs: null };
    queueSave();
    renderSubjects();
    renderTimerUI();
    startTicking();
  }

  /* ---------------- Honest-time adjustment ----------------
     Ending a measurement freezes it (endTs) instead of committing it, then
     asks how much of that span was really spent studying. The frozen state
     is saved, so a reload mid-dialog reopens it rather than losing the
     session or letting the clock keep running. */
  function stopTimer() {
    if (!activeSession || activeSession.endTs) return;
    if (Date.now() >= checkinDeadlineAt(activeSession)) { voidSession(); return; }
    endRestIfAny(activeSession);
    activeSession.endTs = Date.now();
    clearInterval(tickInterval);
    tickInterval = null;
    hideCheckin();
    queueSave();
    openAdjust();
  }

  function adjustedSeconds() {
    const maxMinutes = Number(adjustRange.max);
    const chosen = Math.min(Number(adjustRange.value), maxMinutes);
    // keep the leftover seconds when nothing was trimmed
    return chosen === maxMinutes ? sessionElapsed(activeSession) : chosen * 60;
  }

  function renderAdjust() {
    const seconds = adjustedSeconds();
    adjustValue.textContent = formatDuration(seconds);
    const reward = Math.floor(seconds / 60) * currentStudyIncome();
    adjustReward.innerHTML = reward > 0
      ? `이 시간으로 기록하면 ${reward.toLocaleString('ko-KR')} 골드를 받아요 <span class="gold-icon" aria-hidden="true"></span>`
      : '1분을 채우면 골드를 받을 수 있어요.';
  }

  function openAdjust() {
    const elapsed = sessionElapsed(activeSession);
    const maxMinutes = Math.floor(elapsed / 60);
    if (maxMinutes < 1) { finalizeSession(elapsed); return; }
    adjustRange.max = String(maxMinutes);
    adjustRange.value = String(maxMinutes);
    adjustMax.textContent = formatDurationLabel(maxMinutes * 60);
    adjustMeasured.textContent =
      `측정된 시간은 ${formatDurationLabel(elapsed)}이에요. 실제로 공부한 만큼만 남기고 조절해주세요.`;
    renderAdjust();
    adjustGate.classList.remove('hidden');
  }

  adjustRange.addEventListener('input', renderAdjust);

  adjustConfirmBtn.addEventListener('click', () => {
    if (!activeSession || !activeSession.endTs) return;
    const seconds = adjustedSeconds();
    adjustGate.classList.add('hidden');
    finalizeSession(seconds);
  });

  function finalizeSession(seconds) {
    if (!activeSession) return;
    const subjectId = activeSession.subjectId;
    const subj = subjects.find((s) => s.id === subjectId);

    addStudySeconds(studyDayKey(), subjectId, seconds);
    const reward = Math.floor(seconds / 60) * currentStudyIncome();

    activeSession = null;
    queueSave();

    if (reward > 0) {
      addGold(reward);
      showToast(`⏱️ ${subj ? subj.name : '공부'} ${formatDurationLabel(seconds)} 기록! +${reward.toLocaleString('ko-KR')} 골드 획득 🪙`);
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

  restBtn.addEventListener('click', () => {
    if (!activeSession || activeSession.endTs) return;
    if (activeSession.restStartTs) endRestIfAny(activeSession);
    else activeSession.restStartTs = Date.now();
    queueSave();
    renderRest();
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

  /* Income splits cleanly in two, and the total is defined as the SUM of
     the two displayed halves — so 총 효율 = 경지 효율 + 검 효율 holds
     exactly, on screen and in the actual payout.

     The flat base belongs to the realm half only. Counting it in both
     halves is what used to make them overshoot the total by a fixed
     380G. Each half is rounded on its own and the total adds the two
     rounded halves, so rounding can never break the identity either.

     Realms stack (you keep every rung you climbed); a sword does not —
     only the single blade you have equipped counts.

     1.5 * 1.15 — a flat 15% buff across every realm level. */
  function realmIncomeAt(realmIdx) {
    return niceGold((BASE_STUDY_MIN + cumulativeBonus(REALMS, realmIdx, 'studyBonus')) * 1.725);
  }
  /* Nerfed to 1/5 of the realm-side multiplier — a lucky pull was earning
     far more than the guaranteed, grindable realm track for the same
     study time. */
  function swordIncomeAt(swordIdx) {
    const stars = swordStars[swordIdx] || 0;
    return niceGold(SWORDS[swordIdx].studyBonus * (1.5 / 5) * (1 + ENHANCE_TOTAL_BONUS_BY_STAR[stars]));
  }
  function studyIncomeAt(realmIdx, swordIdx) {
    return realmIncomeAt(realmIdx) + swordIncomeAt(swordIdx);
  }

  function currentStudyIncome() { return studyIncomeAt(realmLevel, swordLevel); }

  function renderStudyHint() {
    const income = currentStudyIncome();
    timerHint.innerHTML = `1분마다 ${income.toLocaleString('ko-KR')} 골드, 1시간이면 ${(income * 60).toLocaleString('ko-KR')} 골드를 획득해요 <span class="gold-icon" aria-hidden="true"></span>`;
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
        name: el('realmName'), hanja: el('realmHanja'), lore: el('realmLore'), desc: el('realmDesc'),
        studyRange: el('realmStudyRange'), badge: el('realmBadge'),
        nextName: el('realmNextName'), upgradeBtn: el('realmUpgradeBtn'), ladderList: el('realmLadderList'),
      },
      maxedNextText: '이미 구도의 완성, 여의경(如意境) 극에 이르렀습니다',
      verb: '경지에 올랐습니다',
    },
  };

  function incomeForTrackIndex(track, index) {
    return realmIncomeAt(index);
  }
  const tierOf = (index) => Math.floor(index / 3);

  // Which ladder row (by index) is currently expanded to show its full
  // lore/desc -- null means none. Reset whenever the ladder itself
  // re-renders from scratch (e.g. after a realm upgrade) so a stale index
  // from a different track/state can't leave the wrong row open.
  let expandedRealmIdx = null;

  function renderCultivationTrack(track) {
    const level = track.getLevel();
    const cur = track.list[level];
    const e = track.els;

    e.name.textContent = cur.name;
    e.name.className = `cultivation-name tier-${tierOf(level)}`;
    e.hanja.textContent = `(${cur.hanja})`;
    e.lore.textContent = cur.lore;
    e.desc.textContent = cur.desc;
    e.studyRange.textContent = `+${incomeForTrackIndex(track, level).toLocaleString('ko-KR')}G`;
    e.badge.textContent = `${level + 1} / ${track.list.length}`;

    const next = track.list[level + 1];
    if (next) {
      e.nextName.textContent = `${next.name} (${next.hanja})`;
      e.upgradeBtn.textContent = `${next.price.toLocaleString('ko-KR')}G로 승급하기`;
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
      const itemEl = node.querySelector('.ladder-item');
      const rowBtn = node.querySelector('.ladder-row');
      node.querySelector('.ladder-rank').textContent = i + 1;
      const nameEl = node.querySelector('.ladder-name');
      nameEl.textContent = item.name;
      nameEl.classList.add(`tier-${tierOf(i)}`);
      node.querySelector('.ladder-hanja').textContent = `(${item.hanja})`;
      node.querySelector('.ladder-range').textContent = `+${incomeForTrackIndex(track, i).toLocaleString('ko-KR')}G`;
      const statusEl = node.querySelector('.ladder-status');
      if (i < level) { itemEl.classList.add('done'); statusEl.textContent = '달성'; }
      else if (i === level) { itemEl.classList.add('current'); statusEl.textContent = '현재'; }
      else { itemEl.classList.add('locked'); statusEl.textContent = `${item.price.toLocaleString('ko-KR')}G`; }

      const isOpen = expandedRealmIdx === i;
      itemEl.classList.toggle('expanded', isOpen);
      rowBtn.setAttribute('aria-expanded', String(isOpen));
      node.querySelector('.ladder-detail-lore').textContent = item.lore;
      node.querySelector('.ladder-detail-desc').textContent = item.desc;
      rowBtn.addEventListener('click', () => {
        expandedRealmIdx = expandedRealmIdx === i ? null : i;
        renderCultivationTrack(track);
      });

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
    renderHeader();
  }

  /* ---------------- 검 뽑기 (가챠) ----------------
     Flat price per draw — it does not scale with realm or the sword you
     have equipped, so the odds table is the only thing that determines
     value here. */
  const DRAW_COST = 50000;
  const MAX_DRAWS_PER_BATCH = 100;

  function drawCost() { return DRAW_COST; }

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
      showToast(`💸 골드가 부족해요. ${count}회 뽑기에 ${total.toLocaleString('ko-KR')}G가 필요합니다.`);
      return;
    }

    gold -= total;
    totalDraws += count;

    const results = [];
    let equippedChanged = false;
    let newlyDiscovered = 0;
    let fragmentsGained = 0;

    for (let i = 0; i < count; i++) {
      const idx = rollSword();
      const isNew = !discovered.includes(idx);
      if (isNew) {
        discovered.push(idx);
        newlyDiscovered++;
      } else {
        // Already own this one — it converts into 별의 조각 instead, scaled
        // by how rare the duplicate itself is.
        fragmentsGained += STAR_FRAGMENTS_BY_RARITY[SWORDS[idx].rarity];
      }
      // Whole "better sword auto-equips, weaker one is kept but not worn" rule.
      const upgraded = swordPower(idx) > swordPower(swordLevel);
      if (upgraded) { swordLevel = idx; equippedChanged = true; }
      results.push({ idx, isNew, upgraded });
    }
    starFragments += fragmentsGained;

    queueSave();
    renderGold();
    renderGachaResults(results);
    renderGachaPanel();
    renderCodex();
    renderStudyHint();
    renderHeader();
    if (tabPanels.enhance.classList.contains('active')) renderEnhance();

    const best = results.reduce((a, b) => (swordPower(b.idx) > swordPower(a.idx) ? b : a));
    const bestSword = SWORDS[best.idx];
    const fragText = fragmentsGained > 0 ? ` (✳ 별의 조각 +${fragmentsGained.toLocaleString('ko-KR')})` : '';
    if (equippedChanged) {
      showToast(`⚔️ ${RARITIES[bestSword.rarity].name} ${bestSword.name}(${bestSword.hanja}) 획득! 자동으로 장착했습니다.${fragText}`);
    } else if (newlyDiscovered > 0) {
      showToast(`📖 새로운 검 ${newlyDiscovered}자루를 도감에 기록했습니다.${fragText}`);
    } else if (fragmentsGained > 0) {
      showToast(`✳ 이미 가진 검이라 별의 조각 ${fragmentsGained.toLocaleString('ko-KR')}개로 바뀌었어요.`);
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
  const epithetGrid = el('epithetGrid');
  const epithetProgress = el('epithetProgress');
  const epithetCardTpl = el('epithetCardTemplate');
  const ownedSwordList = el('ownedSwordList');
  const ownedSwordsCount = el('ownedSwordsCount');
  const ownedSwordEmpty = el('ownedSwordEmpty');

  const equippedEls = {
    name: el('swordName'), nameText: el('swordNameText'), hanja: el('swordHanja'), grade: el('swordGrade'),
    epithet: el('swordEpithet'), enhanceBadge: el('swordEnhanceBadge'),
    lore: el('swordLore'), desc: el('swordDesc'), studyRange: el('swordStudyRange'),
  };

  /* Shared "+N" 강화 badge, reused wherever a sword's name is shown. */
  function setEnhanceBadge(el, stars) {
    if (stars > 0) {
      el.textContent = `+${stars}`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function clampDrawCount() {
    let n = parseInt(gachaCountInput.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > MAX_DRAWS_PER_BATCH) n = MAX_DRAWS_PER_BATCH;
    return n;
  }

  let expandedRarity = null;

  function renderGachaPanel() {
    const cur = SWORDS[swordLevel];
    const rar = RARITIES[cur.rarity];

    equippedEls.nameText.textContent = cur.name;
    equippedEls.name.className = `cultivation-name rar-${cur.rarity}`;
    setEnhanceBadge(equippedEls.enhanceBadge, swordStars[swordLevel] || 0);
    equippedEls.hanja.textContent = `(${cur.hanja})`;
    equippedEls.grade.textContent = `${rar.name} · ${rar.hanja}`;
    equippedEls.grade.className = `sword-grade rar-chip rar-${cur.rarity}`;
    if (cur.epithet) {
      equippedEls.epithet.textContent = `《${cur.epithet}》`;
      equippedEls.epithet.className = `sword-epithet rar-${cur.rarity}`;
      equippedEls.epithet.hidden = false;
    } else {
      equippedEls.epithet.hidden = true;
    }
    equippedEls.lore.textContent = cur.lore;
    equippedEls.desc.textContent = cur.desc;
    equippedEls.studyRange.textContent = `+${swordIncomeAt(swordLevel).toLocaleString('ko-KR')}G`;

    const n = clampDrawCount();
    const cost = drawCost();
    const total = cost * n;
    gachaCostLabel.textContent = `1회 ${cost.toLocaleString('ko-KR')}G · ${n}회 ${total.toLocaleString('ko-KR')}G`;
    gachaDrawBtn.textContent = `${n}회 뽑기`;
    gachaDrawBtn.disabled = gold < total;

    rarityTable.innerHTML = '';
    RARITIES.forEach((r, i) => {
      const swords = SWORDS.map((s, idx) => ({ ...s, idx })).filter((s) => s.rarity === i);
      const isOpen = expandedRarity === i;

      const group = document.createElement('li');
      group.className = 'rarity-group';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `rarity-row rar-${i}${isOpen ? ' open' : ''}`;
      btn.dataset.rarity = String(i);
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.innerHTML = `
        <span class="rarity-name">${r.name}<small>${r.hanja}</small></span>
        <span class="rarity-chance">${r.chance}%</span>
        <span class="rarity-count">${swords.length}종</span>
        <span class="rarity-caret">▾</span>`;
      group.appendChild(btn);

      const sub = document.createElement('ul');
      sub.className = `rarity-sword-list${isOpen ? ' show' : ''}`;
      swords.forEach((s, j) => {
        const item = document.createElement('li');
        item.className = `rarity-sword-item${discovered.includes(s.idx) ? '' : ' undiscovered'}`;
        item.style.animationDelay = isOpen ? `${j * 30}ms` : '0ms';
        item.innerHTML = `<span class="rarity-sword-name">${s.name}</span><span class="rarity-sword-hanja">(${s.hanja})</span><span class="rarity-sword-income">분당 +${swordIncomeAt(s.idx).toLocaleString('ko-KR')}G</span>`;
        sub.appendChild(item);
      });
      group.appendChild(sub);

      rarityTable.appendChild(group);
    });

    renderOwnedSwords();
  }

  /* 장착 검 직접 고르기 — 도감에 기록된 검 중 아무거나 골라 장착할 수 있다.
     더 강한 검을 새로 뽑으면 여전히 자동으로 장착되지만(위 upgraded 로직),
     이후 원하는 다른 보유 검으로 언제든 되돌릴 수 있다. */
  function equipSword(idx) {
    if (idx === swordLevel || !discovered.includes(idx)) return;
    swordLevel = idx;
    queueSave();
    renderGachaPanel();
    renderCodex();
    renderStudyHint();
    renderHeader();
    if (tabPanels.enhance.classList.contains('active')) renderEnhance();
    const s = SWORDS[idx];
    showToast(`⚔️ ${RARITIES[s.rarity].name} ${s.name}(${s.hanja})을(를) 장착했습니다.`);
  }

  function renderOwnedSwords() {
    const owned = discovered
      .map((idx) => ({ idx, ...SWORDS[idx] }))
      .sort((a, b) => swordPower(b.idx) - swordPower(a.idx));

    ownedSwordsCount.textContent = `${discovered.length} / ${SWORDS.length}`;
    ownedSwordEmpty.style.display = owned.length ? 'none' : 'block';

    ownedSwordList.innerHTML = '';
    owned.forEach((s) => {
      const equipped = s.idx === swordLevel;
      const item = document.createElement('li');
      item.className = `owned-sword-item rar-${s.rarity}${equipped ? ' equipped' : ''}`;
      item.innerHTML = `
        <span class="owned-sword-grade rar-chip rar-${s.rarity}">${RARITIES[s.rarity].name}</span>
        <span class="owned-sword-name">${s.name}<small>(${s.hanja})</small></span>
        <span class="owned-sword-income">분당 +${swordIncomeAt(s.idx).toLocaleString('ko-KR')}G</span>
        <button type="button" class="btn-equip" data-idx="${s.idx}" ${equipped ? 'disabled' : ''}>${equipped ? '장착 중' : '장착하기'}</button>`;
      ownedSwordList.appendChild(item);
    });
  }

  ownedSwordList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-equip');
    if (!btn) return;
    equipSword(Number(btn.dataset.idx));
  });

  rarityTable.addEventListener('click', (e) => {
    const btn = e.target.closest('.rarity-row');
    if (!btn) return;
    const i = Number(btn.dataset.rarity);
    expandedRarity = expandedRarity === i ? null : i;
    renderGachaPanel();
  });

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

  /* ---------------- 강화 ---------------- */
  const enhanceFragmentBadge = el('enhanceFragmentBadge');
  const enhanceSwordSelect = el('enhanceSwordSelect');
  const enhanceGrade = el('enhanceGrade');
  const enhanceSwordNameText = el('enhanceSwordNameText');
  const enhanceBadge = el('enhanceBadge');
  const enhanceStars = el('enhanceStars');
  const enhanceIncome = el('enhanceIncome');
  const enhanceNextInfo = el('enhanceNextInfo');
  const enhanceBtn = el('enhanceBtn');
  const enhanceEmpty = el('enhanceEmpty');
  const enhanceDisplay = el('enhanceDisplay');
  const enhanceCardWrap = el('enhanceCardWrap');
  const ENHANCE_BURST_CLASSES = ['enhance-burst-low', 'enhance-burst-high', 'enhance-burst-rainbow'];

  // 0 stars -> no flair, 1-5 -> a modest gold shimmer, 6-9 -> a brighter
  // multicolor glow, 10 -> full rainbow treatment.
  function enhanceTierOf(stars) {
    if (stars >= 10) return 'rainbow';
    if (stars >= 6) return 'high';
    if (stars >= 1) return 'low';
    return 'none';
  }

  // Each star POSITION has its own fixed color (blue -> violet -> magenta
  // -> orange as the row climbs) — reaching that star just fills it in
  // with its own designated color, defined as CSS classes .star-pos-1
  // through .star-pos-10. Not a tier-based recolor of the whole set.
  function renderEnhanceStars(stars) {
    enhanceStars.innerHTML = '';
    for (let i = 1; i <= ENHANCE_MAX_STARS; i++) {
      const img = document.createElement('img');
      const filled = i <= stars;
      img.src = 'img/enhance-star.png';
      img.alt = filled ? '★' : '☆';
      img.className = 'enhance-star';
      if (filled) img.classList.add('filled', `star-pos-${i}`);
      enhanceStars.appendChild(img);
    }
  }

  // Remembers the player's manual pick for the session; falls back to the
  // equipped sword whenever nothing valid is selected yet.
  let selectedEnhanceIdx = null;

  function renderEnhance() {
    enhanceFragmentBadge.innerHTML = `<img class="frag-icon" src="img/star-fragment.png" alt="✳"> ${starFragments.toLocaleString('ko-KR')}`;

    if (!discovered.length) {
      enhanceDisplay.style.display = 'none';
      enhanceEmpty.style.display = 'block';
      enhanceSwordSelect.innerHTML = '';
      return;
    }
    enhanceEmpty.style.display = 'none';
    enhanceDisplay.style.display = '';

    if (selectedEnhanceIdx === null || !discovered.includes(selectedEnhanceIdx)) {
      selectedEnhanceIdx = swordLevel;
    }

    const sorted = [...discovered].sort((a, b) => a - b);
    enhanceSwordSelect.innerHTML = '';
    sorted.forEach((idx) => {
      const s = SWORDS[idx];
      const opt = document.createElement('option');
      opt.value = String(idx);
      const starTag = swordStars[idx] ? ` +${swordStars[idx]}` : '';
      opt.textContent = `[${RARITIES[s.rarity].name}] ${s.name}${starTag}`;
      if (idx === selectedEnhanceIdx) opt.selected = true;
      enhanceSwordSelect.appendChild(opt);
    });

    const idx = selectedEnhanceIdx;
    const s = SWORDS[idx];
    const stars = swordStars[idx] || 0;

    enhanceGrade.textContent = `${RARITIES[s.rarity].name} · ${RARITIES[s.rarity].hanja}`;
    enhanceGrade.className = `sword-grade rar-chip rar-${s.rarity}`;
    enhanceSwordNameText.textContent = s.name;
    setEnhanceBadge(enhanceBadge, stars);
    renderEnhanceStars(stars);
    enhanceIncome.textContent = `검 효율 분당 +${swordIncomeAt(idx).toLocaleString('ko-KR')}G`;

    enhanceCardWrap.className = `card enhance-card-wrap sword-theme enhance-tier-${enhanceTierOf(stars)}`;

    if (stars >= ENHANCE_MAX_STARS) {
      enhanceNextInfo.textContent = '이미 최대 10성에 도달했어요.';
      enhanceBtn.disabled = true;
      enhanceBtn.textContent = '강화 완료';
    } else {
      const cost = enhanceCostFor(idx, stars);
      const chance = enhanceChanceFor(idx, stars);
      enhanceNextInfo.innerHTML = `${stars + 1}성 도전 · <img class="frag-icon" src="img/star-fragment.png" alt="✳"> ${cost.toLocaleString('ko-KR')} · 성공 확률 ${chance}%`;
      enhanceBtn.disabled = starFragments < cost;
      enhanceBtn.textContent = `강화하기 (${stars}★ → ${stars + 1}★)`;
    }
  }

  enhanceSwordSelect.addEventListener('change', () => {
    selectedEnhanceIdx = Number(enhanceSwordSelect.value);
    renderEnhance();
  });

  function triggerEnhanceEffect(newStars) {
    const cls = `enhance-burst-${enhanceTierOf(newStars)}`;
    enhanceCardWrap.classList.remove(...ENHANCE_BURST_CLASSES);
    void enhanceCardWrap.offsetWidth; // force reflow so replaying the animation always restarts it
    if (ENHANCE_BURST_CLASSES.includes(cls)) enhanceCardWrap.classList.add(cls);
    setTimeout(() => enhanceCardWrap.classList.remove(cls), 1400);
  }

  enhanceBtn.addEventListener('click', () => {
    const idx = selectedEnhanceIdx;
    if (idx === null || !discovered.includes(idx)) return;
    const stars = swordStars[idx] || 0;
    if (stars >= ENHANCE_MAX_STARS) return;
    const cost = enhanceCostFor(idx, stars);
    if (starFragments < cost) {
      showToast(`✳ 별의 조각이 부족해요. ${cost.toLocaleString('ko-KR')}개가 필요합니다.`);
      return;
    }
    starFragments -= cost;
    const chance = enhanceChanceFor(idx, stars);
    const success = Math.random() * 100 < chance;
    const s = SWORDS[idx];

    if (success) {
      swordStars[idx] = stars + 1;
      queueSave();
      renderEnhance();
      renderGachaPanel();
      renderCodex();
      renderStudyHint();
      renderHeader();
      triggerEnhanceEffect(stars + 1);
      showToast(`✨ ${s.name} 강화 성공! ${stars + 1}★ 달성 (검 효율 +${ENHANCE_BONUS_BY_STAR[stars] * 100}%p)`);
    } else {
      queueSave();
      renderEnhance();
      showToast(`💔 강화에 실패했어요. 별의 조각만 소모됐어요. (${s.name})`);
    }
  });

  /* ---------------- 도감 ---------------- */
  function renderCodex() {
    codexGrid.innerHTML = '';
    codexProgress.textContent = `${discovered.length} / ${SWORDS.length}`;

    // Grade order rather than raw array position — later-appended grades
    // (e.g. 용검) and homage swords tacked onto an earlier grade would
    // otherwise show up out of order, since SWORDS only guarantees new
    // entries are appended at the end (see the SWORDS comment above).
    // A stable sort keeps each grade's own original relative order intact.
    const bySwordGrade = SWORDS
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.rarity - b.s.rarity);

    bySwordGrade.forEach(({ s, i }) => {
      const found = discovered.includes(i);
      const node = codexCardTpl.content.cloneNode(true);
      const card = node.querySelector('.codex-card');
      card.classList.add(`rar-${s.rarity}`);
      if (!found) card.classList.add('locked');
      if (i === swordLevel) card.classList.add('equipped');

      node.querySelector('.codex-grade').textContent = RARITIES[s.rarity].name;
      node.querySelector('.codex-name-text').textContent = s.name;   // name is always shown
      setEnhanceBadge(node.querySelector('.codex-enhance-badge'), swordStars[i] || 0);
      node.querySelector('.codex-hanja').textContent = found ? `(${s.hanja})` : '(???)';
      const epithetEl = node.querySelector('.codex-epithet');
      if (s.epithet) {
        epithetEl.textContent = found ? `《${s.epithet}》` : '《???》';
      } else {
        epithetEl.remove();
      }
      node.querySelector('.codex-lore').textContent = found ? s.lore : '???';
      node.querySelector('.codex-desc').textContent = found ? s.desc : '???';
      // Each blade's own efficiency, matching the 검 tab — so the codex can
      // be read as a straight blade-vs-blade comparison, and adding it to
      // your 경지 효율 gives the total the main tab shows.
      node.querySelector('.codex-bonus').textContent = found
        ? `검 효율 분당 +${swordIncomeAt(i).toLocaleString('ko-KR')}G`
        : '검 효율 분당 +???';
      codexGrid.appendChild(node);
    });
  }

  /* ---------------- 별호록 ----------------
     Every 보검(寶劍)-and-up blade carries its own epithet. Eligibility and
     the earned state both fall straight out of `discovered`, so a blade
     pulled before this feature shipped is granted its epithet the moment
     this renders — no separate award step or migration needed. */
  function renderEpithets() {
    epithetGrid.innerHTML = '';
    const eligible = SWORDS.map((s, i) => ({ ...s, idx: i })).filter((s) => s.epithet);
    const earnedCount = eligible.filter((s) => discovered.includes(s.idx)).length;
    epithetProgress.textContent = `${earnedCount} / ${eligible.length}`;

    eligible.forEach((s) => {
      const found = discovered.includes(s.idx);
      const node = epithetCardTpl.content.cloneNode(true);
      const card = node.querySelector('.epithet-card');
      card.classList.add(`rar-${s.rarity}`);
      if (!found) card.classList.add('locked');
      if (s.idx === swordLevel) card.classList.add('equipped');

      node.querySelector('.epithet-grade').textContent = RARITIES[s.rarity].name;
      node.querySelector('.epithet-title').textContent = found ? s.epithet : '???';
      node.querySelector('.epithet-sword-name').textContent = found ? `${s.name} (${s.hanja})` : '미발견 검';
      epithetGrid.appendChild(node);
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
  /* The leaderboard's study_today/week/month columns are snapshots written
     by flushSave() — nothing pushes a fresh one just because the clock
     crossed the 5am study-day boundary. Left open across that moment, the
     board (and this device's own "오늘" displays) would keep showing
     yesterday's numbers under today's label until some unrelated save
     happened to fire. Polling studyDayKey() and re-saving the instant it
     changes closes that gap without needing a live/materialized column. */
  let lastStudyDay = null;
  async function checkStudyDayRollover() {
    const cur = studyDayKey();
    if (cur === lastStudyDay) return;
    lastStudyDay = cur;
    renderTodayTotal();
    renderSubjects();
    // Not queueSave(): the ranking/profile re-render right below reads the
    // leaderboard row straight back from the server, so it needs the reset
    // committed now, not after the usual 500ms debounce.
    await flushSave();
    if (tabPanels.ranking.classList.contains('active')) renderRanking(currentRankCategory);
    if (tabPanels.profile.classList.contains('active')) renderProfile();
  }

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
    resumeSession();
    renderCultivationTrack(CULT_TRACKS.realm);
    renderGachaPanel();
    renderGachaResults([]);
    renderCodex();

    lastStudyDay = studyDayKey();
    setInterval(checkStudyDayRollover, 60000);
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
