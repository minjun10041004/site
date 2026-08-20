(() => {
  'use strict';

  /* ---------------- Storage helpers ---------------- */
  const STORE_KEYS = {
    schedules: 'momentum_schedules',
    todos: 'momentum_todos',
    theme: 'momentum_theme',
    gold: 'momentum_gold',
    subjects: 'momentum_subjects',
    study: 'momentum_study',
    activeSession: 'momentum_active_session',
    realmLevel: 'momentum_realm_level',
    swordLevel: 'momentum_sword_level',
    todoGold: 'momentum_todo_gold_claimed',
  };

  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  let schedules = load(STORE_KEYS.schedules, []);
  let todosByDate = load(STORE_KEYS.todos, {});
  let gold = load(STORE_KEYS.gold, 1000);
  let subjects = load(STORE_KEYS.subjects, []);
  let studyByDate = load(STORE_KEYS.study, {});
  let activeSession = load(STORE_KEYS.activeSession, null);
  let realmLevel = load(STORE_KEYS.realmLevel, 0);
  let swordLevel = load(STORE_KEYS.swordLevel, 0);
  let todoGoldClaimed = load(STORE_KEYS.todoGold, {});

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

  const themeToggle = el('themeToggle');

  const goldAmountEl = el('goldAmount');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    main: el('panel-main'),
    study: el('panel-study'),
    realm: el('panel-realm'),
    sword: el('panel-sword'),
  };

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
    { name: '이류무사', hanja: '二流武士', price: 20000, studyBonus: 300, dailyBonus: 5000,
      desc: '어설프던 초식이 제법 날카로워졌다. 이제 겨우 무림의 문턱을 넘본다.' },
    { name: '일류무사', hanja: '一流武士', price: 45000, studyBonus: 400, dailyBonus: 7000,
      desc: '정파 명문 문파의 후기지수들과 어깨를 견줄 만한 실력을 갖췄다.' },
    { name: '절정 초입', hanja: '絶頂 初入', price: 90000, studyBonus: 600, dailyBonus: 10000,
      desc: '내공이 단전에 뿌리내리기 시작하며, 비로소 「고수」라 불리기 시작한다.' },
    { name: '절정 중반', hanja: '絶頂 中盤', price: 160000, studyBonus: 800, dailyBonus: 13000,
      desc: '일 갑자에 가까운 내공을 다루며, 한 지역을 대표하는 강자로 자리매김한다.' },
    { name: '절정 대성', hanja: '絶頂 大成', price: 280000, studyBonus: 1000, dailyBonus: 17000,
      desc: '절정의 끝에 다다라, 펼치는 초식 하나하나에 산을 가르는 기세가 실린다.' },
    { name: '초절정', hanja: '超絶頂', price: 480000, studyBonus: 1400, dailyBonus: 22000,
      desc: '인간의 한계를 넘어섰다는 평가를 받는 경지. 구파일방의 장로급 고수다.' },
    { name: '화경 초입', hanja: '化境 初入', price: 800000, studyBonus: 1800, dailyBonus: 28000,
      desc: '몸과 내공이 하나로 화하기 시작하며, 검이 곧 몸이 되는 감각을 깨우친다.' },
    { name: '화경 중반', hanja: '化境 中盤', price: 1300000, studyBonus: 2300, dailyBonus: 35000,
      desc: '이기어검(以氣馭劍)의 초입에 다다른, 천하에 손꼽히는 절대 고수.' },
    { name: '화경 대성', hanja: '化境 大成', price: 2100000, studyBonus: 2900, dailyBonus: 43000,
      desc: '한 문파의 장문인조차 함부로 대하지 못하는, 사실상 무림 최정상의 반열.' },
    { name: '현경', hanja: '玄境', price: 3400000, studyBonus: 3600, dailyBonus: 52000,
      desc: '생각이 곧 검이 되는 경지. 이미 인간의 무학을 초월했다는 평을 듣는다.' },
    { name: '생사경', hanja: '生死境', price: 5400000, studyBonus: 4400, dailyBonus: 62000,
      desc: '삶과 죽음의 경계를 손끝으로 다루는 자. 전설 속 인물로나 회자되던 경지.' },
    { name: '삼화취정', hanja: '三花聚頂', price: 8500000, studyBonus: 5300, dailyBonus: 74000,
      desc: '정(精)·기(氣)·신(神) 세 송이 꽃이 정수리에 모이며, 신선의 반열에 발을 들인다.' },
    { name: '오기조원', hanja: '五氣朝元', price: 13000000, studyBonus: 6300, dailyBonus: 88000,
      desc: '오장육부의 기운이 하나의 근원으로 모이는, 우화등선을 목전에 둔 경지.' },
    { name: '반로환동', hanja: '返老還童', price: 20000000, studyBonus: 7500, dailyBonus: 104000,
      desc: '늙은 육신이 다시 어린아이처럼 회춘하는, 인간의 굴레를 벗어난 신비의 경지.' },
    { name: '탈태환골', hanja: '奪胎換骨', price: 30000000, studyBonus: 9000, dailyBonus: 123000,
      desc: '범인의 태를 벗고 신선의 뼈로 다시 태어나는, 전설로만 전해지던 경지.' },
    { name: '우화등선', hanja: '羽化登仙', price: 45000000, studyBonus: 11000, dailyBonus: 146000,
      desc: '육신을 벗고 날개를 얻어 하늘로 오른다. 그 이름 자체가 곧 신화가 된다.' },
    { name: '자연경', hanja: '自然境', price: 68000000, studyBonus: 14000, dailyBonus: 175000,
      desc: '자연과 하나가 되어, 더 이상 「경지」라는 말로도 설명할 수 없는 무학의 종착점.' },
  ];

  /* ---------------- Sword ladder (검) ---------------- */
  const SWORDS = [
    { name: '목검', hanja: '木劍', price: 0, studyBonus: 0, dailyBonus: 0,
      desc: '수련용 목검. 볼품없지만 이 검으로 시작한 고수가 한둘이 아니다.' },
    { name: '철검', hanja: '鐵劍', price: 15000, studyBonus: 250, dailyBonus: 4000,
      desc: '저잣거리 대장간에서 벼려낸 투박한 첫 애병.' },
    { name: '청강검', hanja: '靑鋼劍', price: 35000, studyBonus: 400, dailyBonus: 6500,
      desc: '푸른 강철로 정련되어 예기가 살아있는 검.' },
    { name: '백은검', hanja: '白銀劍', price: 70000, studyBonus: 600, dailyBonus: 9500,
      desc: '은은한 백색 광택을 내는, 명문 무기점의 수작.' },
    { name: '한빙검', hanja: '寒氷劍', price: 130000, studyBonus: 850, dailyBonus: 13500,
      desc: '베는 순간 서릿발이 서린다는 극음(極陰)의 명검.' },
    { name: '적염검', hanja: '赤炎劍', price: 230000, studyBonus: 1150, dailyBonus: 18500,
      desc: '칼날에 불꽃이 어른거린다는 극양(極陽)의 보검.' },
    { name: '뇌명검', hanja: '雷鳴劍', price: 400000, studyBonus: 1550, dailyBonus: 25000,
      desc: '휘두르면 천둥소리가 울린다는 전설의 신병(神兵).' },
    { name: '파풍검', hanja: '破風劍', price: 700000, studyBonus: 2050, dailyBonus: 33000,
      desc: '바람조차 갈라버린다는, 쾌검의 극의가 담긴 검.' },
    { name: '용린검', hanja: '龍鱗劍', price: 1200000, studyBonus: 2700, dailyBonus: 43000,
      desc: '용의 비늘을 벼려 만들었다는 전설 속의 신검.' },
    { name: '천마검', hanja: '天魔劍', price: 2000000, studyBonus: 3500, dailyBonus: 55000,
      desc: '마교 역대 교주만이 다뤘다는, 하늘마저 두려워한 마검.' },
    { name: '만년현철검', hanja: '萬年玄鐵劍', price: 3400000, studyBonus: 4500, dailyBonus: 70000,
      desc: '만년 묵은 현철로 주조된, 그 자체로 하나의 보물인 신검.' },
    { name: '파천검', hanja: '破天劍', price: 5600000, studyBonus: 5800, dailyBonus: 89000,
      desc: '하늘을 가른다는 이름 그대로, 존재 자체가 재앙인 신검.' },
    { name: '주선검', hanja: '誅仙劍', price: 9200000, studyBonus: 7400, dailyBonus: 112000,
      desc: '선인마저 베어낸다는 태고의 흉기. 그 이름만으로 강호를 떨게 한다.' },
    { name: '반고신검', hanja: '盤古神劍', price: 15000000, studyBonus: 9500, dailyBonus: 140000,
      desc: '천지를 개벽한 반고가 남겼다는 전설의 신검. 이 검을 쥔 자, 곧 하늘이 된다.' },
  ];

  const BASE_STUDY_MIN = 2000;
  const BASE_STUDY_MAX = 4000;
  const BASE_DAILY_MAX = 100000;

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
        save(STORE_KEYS.schedules, schedules);
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
    save(STORE_KEYS.schedules, schedules);
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
    save(STORE_KEYS.todos, todosByDate);
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
    save(STORE_KEYS.gold, gold);
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
    save(STORE_KEYS.study, studyByDate);
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
        save(STORE_KEYS.subjects, subjects);
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
    save(STORE_KEYS.activeSession, activeSession);
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
    save(STORE_KEYS.activeSession, null);

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
    save(STORE_KEYS.subjects, subjects);
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
    return [BASE_STUDY_MIN + bonus, BASE_STUDY_MAX + bonus];
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
    save(STORE_KEYS.todoGold, todoGoldClaimed);
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
      setLevel: (v) => { realmLevel = v; save(STORE_KEYS.realmLevel, realmLevel); },
      getOtherLevel: () => swordLevel,
      els: {
        name: el('realmName'), hanja: el('realmHanja'), desc: el('realmDesc'),
        studyRange: el('realmStudyRange'), dailyMax: el('realmDailyMax'), badge: el('realmBadge'),
        nextName: el('realmNextName'), upgradeBtn: el('realmUpgradeBtn'), ladderList: el('realmLadderList'),
      },
      maxedNextText: '이미 무학의 정점, 자연경(自然境)에 이르렀습니다',
      verb: '경지에 올랐습니다',
    },
    sword: {
      axis: 'sword',
      list: SWORDS,
      getLevel: () => swordLevel,
      setLevel: (v) => { swordLevel = v; save(STORE_KEYS.swordLevel, swordLevel); },
      getOtherLevel: () => realmLevel,
      els: {
        name: el('swordName'), hanja: el('swordHanja'), desc: el('swordDesc'),
        studyRange: el('swordStudyRange'), dailyMax: el('swordDailyMax'), badge: el('swordBadge'),
        nextName: el('swordNextName'), upgradeBtn: el('swordUpgradeBtn'), ladderList: el('swordLadderList'),
      },
      maxedNextText: '이미 천하제일검, 반고신검(盤古神劍)을 손에 넣었습니다',
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
    save(STORE_KEYS.gold, gold);
    track.setLevel(level + 1);
    renderGold();
    renderCultivationTrack(CULT_TRACKS.realm);
    renderCultivationTrack(CULT_TRACKS.sword);
    renderStudyHint();
    showToast(`🌟 ${next.name}(${next.hanja}) ${track.verb}`);
  }

  /* ---------------- Theme ---------------- */
  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      themeToggle.textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      themeToggle.textContent = '🌙';
    }
  }

  themeToggle.addEventListener('click', () => {
    const current = load(STORE_KEYS.theme, 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    save(STORE_KEYS.theme, next);
    applyTheme(next);
  });

  /* ---------------- Init ---------------- */
  function init() {
    applyTheme(load(STORE_KEYS.theme, 'dark'));
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

  init();
})();
