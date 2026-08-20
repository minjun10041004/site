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

  let schedules = [];
  let todosByDate = {};
  let gold = 1000;
  let subjects = [];
  let studyByDate = {};
  let activeSession = null;
  let realmLevel = 0;
  let swordLevel = 0;
  let todoGoldClaimed = {};

  function collectState() {
    return { schedules, todosByDate, gold, subjects, studyByDate, activeSession, realmLevel, swordLevel, todoGoldClaimed };
  }

  function applyState(data) {
    schedules = data.schedules ?? [];
    todosByDate = data.todosByDate ?? {};
    gold = data.gold ?? 1000;
    subjects = data.subjects ?? [];
    studyByDate = data.studyByDate ?? {};
    activeSession = data.activeSession ?? null;
    realmLevel = data.realmLevel ?? 0;
    swordLevel = data.swordLevel ?? 0;
    todoGoldClaimed = data.todoGoldClaimed ?? {};
  }

  async function flushSave() {
    if (!currentUserId) return;
    await sb.from('app_data').upsert({
      user_id: currentUserId,
      data: collectState(),
      updated_at: new Date().toISOString(),
    });
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
  const subjectBadge = el('subjectBadge');
  const subjectList = el('subjectList');
  const subjectEmpty = el('subjectEmpty');
  const subjectForm = el('subjectForm');
  const subjectTextInput = el('subjectText');
  const subjectItemTpl = el('subjectItemTemplate');

  const ladderRowTpl = el('ladderRowTemplate');

  const toastEl = el('toast');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

  /* ---------------- Cultivation realm ladder (경지) ---------------- */
  const REALMS = [
    { name: '삼류무사', hanja: '三流武士', price: 0, studyBonus: 0, dailyBonus: 0,
      desc: '무공의 첫걸음을 뗀 초심자. 검을 쥐는 법조차 서투르지만, 모든 전설은 여기서 시작된다.' },
    { name: '이류무사', hanja: '二流武士', price: 8000, studyBonus: 1000, dailyBonus: 10000,
      desc: '어설프던 초식이 제법 날카로워졌다. 이제 겨우 무림의 문턱을 넘본다.' },
    { name: '일류무사', hanja: '一流武士', price: 18000, studyBonus: 1000, dailyBonus: 14000,
      desc: '정파 명문 문파의 후기지수들과 어깨를 견줄 만한 실력을 갖췄다.' },
    { name: '절정 초입', hanja: '絶頂 初入', price: 36000, studyBonus: 1000, dailyBonus: 20000,
      desc: '내공이 단전에 뿌리내리기 시작하며, 비로소 「고수」라 불리기 시작한다.' },
    { name: '절정 중반', hanja: '絶頂 中盤', price: 64000, studyBonus: 2000, dailyBonus: 26000,
      desc: '일 갑자에 가까운 내공을 다루며, 한 지역을 대표하는 강자로 자리매김한다.' },
    { name: '절정 대성', hanja: '絶頂 大成', price: 110000, studyBonus: 2000, dailyBonus: 34000,
      desc: '절정의 끝에 다다라, 펼치는 초식 하나하나에 산을 가르는 기세가 실린다.' },
    { name: '초절정', hanja: '超絶頂', price: 190000, studyBonus: 3000, dailyBonus: 44000,
      desc: '인간의 한계를 넘어섰다는 평가를 받는 경지. 구파일방의 장로급 고수다.' },
    { name: '화경 초입', hanja: '化境 初入', price: 320000, studyBonus: 4000, dailyBonus: 56000,
      desc: '몸과 내공이 하나로 화하기 시작하며, 검이 곧 몸이 되는 감각을 깨우친다.' },
    { name: '화경 중반', hanja: '化境 中盤', price: 520000, studyBonus: 5000, dailyBonus: 70000,
      desc: '이기어검(以氣馭劍)의 초입에 다다른, 천하에 손꼽히는 절대 고수.' },
    { name: '화경 대성', hanja: '化境 大成', price: 840000, studyBonus: 6000, dailyBonus: 86000,
      desc: '한 문파의 장문인조차 함부로 대하지 못하는, 사실상 무림 최정상의 반열.' },
    { name: '현경', hanja: '玄境', price: 1400000, studyBonus: 8000, dailyBonus: 104000,
      desc: '생각이 곧 검이 되는 경지. 이미 인간의 무학을 초월했다는 평을 듣는다.' },
    { name: '생사경', hanja: '生死境', price: 2200000, studyBonus: 10000, dailyBonus: 124000,
      desc: '삶과 죽음의 경계를 손끝으로 다루는 자. 전설 속 인물로나 회자되던 경지.' },
    { name: '삼화취정', hanja: '三花聚頂', price: 3400000, studyBonus: 12000, dailyBonus: 148000,
      desc: '정(精)·기(氣)·신(神) 세 송이 꽃이 정수리에 모이며, 신선의 반열에 발을 들인다.' },
    { name: '오기조원', hanja: '五氣朝元', price: 5200000, studyBonus: 14000, dailyBonus: 176000,
      desc: '오장육부의 기운이 하나의 근원으로 모이는, 우화등선을 목전에 둔 경지.' },
    { name: '반로환동', hanja: '返老還童', price: 8000000, studyBonus: 16000, dailyBonus: 208000,
      desc: '늙은 육신이 다시 어린아이처럼 회춘하는, 인간의 굴레를 벗어난 신비의 경지.' },
    { name: '탈태환골', hanja: '奪胎換骨', price: 12000000, studyBonus: 20000, dailyBonus: 246000,
      desc: '범인의 태를 벗고 신선의 뼈로 다시 태어나는, 전설로만 전해지던 경지.' },
    { name: '우화등선', hanja: '羽化登仙', price: 18000000, studyBonus: 24000, dailyBonus: 292000,
      desc: '육신을 벗고 날개를 얻어 하늘로 오른다. 그 이름 자체가 곧 신화가 된다.' },
    { name: '자연경', hanja: '自然境', price: 27000000, studyBonus: 31000, dailyBonus: 350000,
      desc: '자연과 하나가 되어, 더 이상 「경지」라는 말로도 설명할 수 없는 무학의 종착점.' },
    { name: '지선', hanja: '地仙', price: 40000000, studyBonus: 37000, dailyBonus: 410000,
      desc: '속세를 떠나지 않고도 신선의 경지에 이른 자. 인간과 신선의 경계에 선 존재.' },
    { name: '천선', hanja: '天仙', price: 58000000, studyBonus: 45000, dailyBonus: 480000,
      desc: '하늘의 반열에 오른 신선. 더 이상 인간의 잣대로는 가늠할 수 없는 존재가 되었다.' },
    { name: '금선', hanja: '金仙', price: 84000000, studyBonus: 54000, dailyBonus: 560000,
      desc: '황금빛 법신을 이룬 대신선. 하늘의 도(道) 그 자체를 다루기 시작한다.' },
    { name: '대라금선', hanja: '大羅金仙', price: 120000000, studyBonus: 65000, dailyBonus: 650000,
      desc: '삼계를 통틀어 손꼽히는 지고의 신선. 그 존재만으로 하나의 하늘이 열린다.' },
    { name: '조화경', hanja: '造化境', price: 172000000, studyBonus: 78000, dailyBonus: 760000,
      desc: '이치를 넘어 조화(造化) 그 자체를 손에 쥔, 언어로는 형용할 수 없는 미지의 영역.' },
    { name: '천인합일', hanja: '天人合一', price: 248000000, studyBonus: 95000, dailyBonus: 890000,
      desc: '하늘과 사람이 마침내 하나가 되었다. 더는 오를 곳이 없는, 구도(求道)의 완성.' },
  ];

  /* ---------------- Sword ladder (검) ---------------- */
  const SWORDS = [
    { name: '목검', hanja: '木劍', price: 0, studyBonus: 0, dailyBonus: 0,
      desc: '수련용 목검. 볼품없지만 이 검으로 시작한 고수가 한둘이 아니다.' },
    { name: '철검', hanja: '鐵劍', price: 6000, studyBonus: 1000, dailyBonus: 8000,
      desc: '저잣거리 대장간에서 벼려낸 투박한 첫 애병.' },
    { name: '청강검', hanja: '靑鋼劍', price: 14000, studyBonus: 1000, dailyBonus: 13000,
      desc: '푸른 강철로 정련되어 예기가 살아있는 검.' },
    { name: '백은검', hanja: '白銀劍', price: 28000, studyBonus: 1000, dailyBonus: 19000,
      desc: '은은한 백색 광택을 내는, 명문 무기점의 수작.' },
    { name: '한빙검', hanja: '寒氷劍', price: 52000, studyBonus: 2000, dailyBonus: 27000,
      desc: '베는 순간 서릿발이 서린다는 극음(極陰)의 명검.' },
    { name: '적염검', hanja: '赤炎劍', price: 92000, studyBonus: 3000, dailyBonus: 37000,
      desc: '칼날에 불꽃이 어른거린다는 극양(極陽)의 보검.' },
    { name: '뇌명검', hanja: '雷鳴劍', price: 160000, studyBonus: 3000, dailyBonus: 50000,
      desc: '휘두르면 천둥소리가 울린다는 전설의 신병(神兵).' },
    { name: '파풍검', hanja: '破風劍', price: 280000, studyBonus: 5000, dailyBonus: 66000,
      desc: '바람조차 갈라버린다는, 쾌검의 극의가 담긴 검.' },
    { name: '용린검', hanja: '龍鱗劍', price: 480000, studyBonus: 6000, dailyBonus: 86000,
      desc: '용의 비늘을 벼려 만들었다는 전설 속의 신검.' },
    { name: '천마검', hanja: '天魔劍', price: 800000, studyBonus: 8000, dailyBonus: 110000,
      desc: '마교 역대 교주만이 다뤘다는, 하늘마저 두려워한 마검.' },
    { name: '만년현철검', hanja: '萬年玄鐵劍', price: 1400000, studyBonus: 10000, dailyBonus: 140000,
      desc: '만년 묵은 현철로 주조된, 그 자체로 하나의 보물인 신검.' },
    { name: '파천검', hanja: '破天劍', price: 2200000, studyBonus: 13000, dailyBonus: 178000,
      desc: '하늘을 가른다는 이름 그대로, 존재 자체가 재앙인 신검.' },
    { name: '주선검', hanja: '誅仙劍', price: 3700000, studyBonus: 16000, dailyBonus: 224000,
      desc: '선인마저 베어낸다는 태고의 흉기. 그 이름만으로 강호를 떨게 한다.' },
    { name: '반고신검', hanja: '盤古神劍', price: 6000000, studyBonus: 21000, dailyBonus: 280000,
      desc: '천지를 개벽한 반고가 남겼다는 전설의 신검. 이 검을 쥔 자, 곧 하늘이 된다.' },
    { name: '개천검', hanja: '開天劍', price: 8800000, studyBonus: 25000, dailyBonus: 330000,
      desc: '닫힌 하늘을 강제로 열어젖힌다는 창세의 신검. 반고 이후 두 번째로 하늘을 가른 자만이 얻는다.' },
    { name: '창세검', hanja: '創世劍', price: 13000000, studyBonus: 31000, dailyBonus: 390000,
      desc: '무(無)에서 유(有)를 빚어낸다는 태초의 권능이 깃든 검.' },
    { name: '삼라만상검', hanja: '森羅萬象劍', price: 19000000, studyBonus: 37000, dailyBonus: 460000,
      desc: '세상 만물의 이치가 검신에 아로새겨진, 존재 자체가 하나의 우주인 신검.' },
    { name: '육도윤회검', hanja: '六道輪廻劍', price: 27000000, studyBonus: 45000, dailyBonus: 540000,
      desc: '생과 사, 윤회의 여섯 갈래 길을 넘나든다는 금단의 신검.' },
    { name: '태극혼돈검', hanja: '太極混沌劍', price: 39000000, studyBonus: 55000, dailyBonus: 640000,
      desc: '혼돈에서 태극이, 태극에서 삼라만상이 태어났다는 만물의 근원을 담은 검.' },
    { name: '심검', hanja: '心劍', price: 57000000, studyBonus: 67000, dailyBonus: 760000,
      desc: '검은 손이 아닌 마음에 있다. 실체 없는 검으로도 천하를 벤다는 절대의 깨달음.' },
    { name: '무형검', hanja: '無形劍', price: 82000000, studyBonus: 82000, dailyBonus: 900000,
      desc: '형(形)조차 초월한 검의 종착점. 검을 쥐지 않아도, 그 앞에 설 자가 없다.' },
  ];

  const BASE_STUDY_MIN = 2500;
  const BASE_DAILY_MAX = 150000;

  /* ---------------- Quotes ---------------- */
  const QUOTES = [
    '오늘도 한 걸음, 미래의 나에게 선물하는 하루.',
    '작은 진전도 진전이다. 멈추지만 않으면 돼.',
    '완벽보다 완료. 오늘의 할 일을 하나씩 지워보자.',
    '꾸준함이 재능을 이긴다.',
    '오늘 심은 노력이 내일의 결과가 된다.',
    'D-Day가 다가올수록, 나는 더 단단해진다.',
    '지금의 1%가 쌓여 100%가 된다.',
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
    settleDailyTodoGold(pct);

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
    for (let i = 13; i >= 0; i--) days.push(addDays(todayK, -i));

    let hasAny = false;

    days.forEach((key) => {
      const pct = computeDayPercent(key);
      if (pct !== null) hasAny = true;
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
      cell.appendChild(dayLabel);
      cell.appendChild(pctLabel);
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
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ---------------- Study Timer ---------------- */
  let selectedSubjectId = activeSession ? activeSession.subjectId : null;
  let tickInterval = null;

  const formatDuration = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  };

  const formatStudyLabel = (totalSeconds) => {
    const mins = Math.floor(totalSeconds / 60);
    if (mins < 60) return `오늘 ${mins}분`;
    return `오늘 ${Math.floor(mins / 60)}시간 ${mins % 60}분`;
  };

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

    const blocks = Math.floor(elapsedSeconds / 600);
    const [rangeMin, rangeMax] = currentStudyRange();
    let reward = 0;
    for (let i = 0; i < blocks; i++) reward += randomInt(rangeMin, rangeMax);

    activeSession = null;
    queueSave();

    if (reward > 0) {
      addGold(reward);
      showToast(`⏱️ ${subj ? subj.name : '공부'} 측정 완료! +${reward.toLocaleString('ko-KR')} 골드 획득 🪙`);
    } else {
      showToast('⏱️ 측정 종료! 10분을 채우면 골드를 받을 수 있어요.');
    }

    renderSubjects();
    renderTimerUI();
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

  function studyRangeAt(realmIdx, swordIdx) {
    const bonus = cumulativeBonus(REALMS, realmIdx, 'studyBonus') + cumulativeBonus(SWORDS, swordIdx, 'studyBonus');
    const min = BASE_STUDY_MIN + bonus;
    return [min, min * 2];
  }

  function dailyMaxAt(realmIdx, swordIdx) {
    const bonus = cumulativeBonus(REALMS, realmIdx, 'dailyBonus') + cumulativeBonus(SWORDS, swordIdx, 'dailyBonus');
    return BASE_DAILY_MAX + bonus;
  }

  function currentStudyRange() { return studyRangeAt(realmLevel, swordLevel); }
  function currentDailyMax() { return dailyMaxAt(realmLevel, swordLevel); }

  function renderStudyHint() {
    const [min, max] = currentStudyRange();
    timerHint.textContent = `10분마다 ${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')} 골드를 획득해요 🪙`;
  }

  /* ---------------- 오늘 할 일 달성 보상 (자동 정산) ---------------- */
  function settleDailyTodoGold(pctToday) {
    const todayK = todayKey();
    const target = Math.round((pctToday / 100) * currentDailyMax());
    const claimed = todoGoldClaimed[todayK] || 0;
    if (target <= claimed) return;
    const diff = target - claimed;
    todoGoldClaimed[todayK] = target;
    queueSave();
    addGold(diff);
    if (pctToday >= 100) {
      showToast(`🎉 오늘 할 일 100% 달성! +${diff.toLocaleString('ko-KR')} 골드 획득!`);
    }
  }

  /* ---------------- 경지 / 검 승급 (공용) ---------------- */
  const CULT_TRACKS = {
    realm: {
      axis: 'realm',
      list: REALMS,
      getLevel: () => realmLevel,
      setLevel: (v) => { realmLevel = v; queueSave(); },
      getOtherLevel: () => swordLevel,
      els: {
        name: el('realmName'), hanja: el('realmHanja'), desc: el('realmDesc'),
        studyRange: el('realmStudyRange'), dailyMax: el('realmDailyMax'), badge: el('realmBadge'),
        nextName: el('realmNextName'), upgradeBtn: el('realmUpgradeBtn'), ladderList: el('realmLadderList'),
      },
      maxedNextText: '이미 구도의 완성, 천인합일(天人合一)에 이르렀습니다',
      verb: '경지에 올랐습니다',
    },
    sword: {
      axis: 'sword',
      list: SWORDS,
      getLevel: () => swordLevel,
      setLevel: (v) => { swordLevel = v; queueSave(); },
      getOtherLevel: () => realmLevel,
      els: {
        name: el('swordName'), hanja: el('swordHanja'), desc: el('swordDesc'),
        studyRange: el('swordStudyRange'), dailyMax: el('swordDailyMax'), badge: el('swordBadge'),
        nextName: el('swordNextName'), upgradeBtn: el('swordUpgradeBtn'), ladderList: el('swordLadderList'),
      },
      maxedNextText: '이미 검의 종착점, 무형검(無形劍)의 경지에 이르렀습니다',
      verb: '을(를) 손에 넣었습니다',
    },
  };

  function rangeForTrackIndex(track, index) {
    const other = track.getOtherLevel();
    return track.axis === 'realm' ? studyRangeAt(index, other) : studyRangeAt(other, index);
  }
  function dailyMaxForTrackIndex(track, index) {
    const other = track.getOtherLevel();
    return track.axis === 'realm' ? dailyMaxAt(index, other) : dailyMaxAt(other, index);
  }

  function renderCultivationTrack(track) {
    const level = track.getLevel();
    const cur = track.list[level];
    const e = track.els;

    e.name.textContent = cur.name;
    e.hanja.textContent = `(${cur.hanja})`;
    e.desc.textContent = cur.desc;
    const [min, max] = rangeForTrackIndex(track, level);
    e.studyRange.textContent = `${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')}C`;
    e.dailyMax.textContent = `${dailyMaxForTrackIndex(track, level).toLocaleString('ko-KR')}C`;
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
      node.querySelector('.ladder-name').textContent = item.name;
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
    queueSave();
    track.setLevel(level + 1);
    renderGold();
    renderCultivationTrack(CULT_TRACKS.realm);
    renderCultivationTrack(CULT_TRACKS.sword);
    renderStudyHint();
    showToast(`🌟 ${next.name}(${next.hanja}) ${track.verb}`);
  }

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
    if (activeSession) startTicking();
    renderCultivationTrack(CULT_TRACKS.realm);
    renderCultivationTrack(CULT_TRACKS.sword);
  }

  /* ---------------- Session lifecycle ---------------- */
  async function enterApp(user) {
    currentUserId = user.id;
    settingsUsernameEl.textContent = user.user_metadata?.username || user.email.split('@')[0];
    await loadUserState();
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
