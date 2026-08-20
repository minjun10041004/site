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
    inventory: 'momentum_inventory',
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
  let inventory = load(STORE_KEYS.inventory, {});

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
    shop: el('panel-shop'),
    inventory: el('panel-inventory'),
  };

  const timerSubjectLabel = el('timerSubjectLabel');
  const timerDisplay = el('timerDisplay');
  const measureBtn = el('measureBtn');
  const subjectBadge = el('subjectBadge');
  const subjectList = el('subjectList');
  const subjectEmpty = el('subjectEmpty');
  const subjectForm = el('subjectForm');
  const subjectTextInput = el('subjectText');
  const subjectItemTpl = el('subjectItemTemplate');

  const shopBadge = el('shopBadge');
  const shopItemGrid = el('shopItemGrid');
  const shopItemTpl = el('shopItemTemplate');
  const shopDetailEmpty = el('shopDetailEmpty');
  const shopDetailContent = el('shopDetailContent');
  const shopDetailIcon = el('shopDetailIcon');
  const shopDetailName = el('shopDetailName');
  const shopDetailTier = el('shopDetailTier');
  const shopDetailDesc = el('shopDetailDesc');
  const shopDetailPrice = el('shopDetailPrice');
  const shopBuyBtn = el('shopBuyBtn');
  const shopBuyMsg = el('shopBuyMsg');

  const inventoryBadge = el('inventoryBadge');
  const inventoryGrid = el('inventoryGrid');
  const inventoryEmpty = el('inventoryEmpty');
  const inventoryItemTpl = el('inventoryItemTemplate');

  const toastEl = el('toast');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

  /* ---------------- RPG Shop catalog ---------------- */
  const SHOP_ITEMS = [
    { id: 'wooden-sword', icon: '🗡️', tier: '커먼', rarity: 'common', name: '초심자의 목검', price: 120000,
      desc: '수련생이라면 누구나 한 번쯤 쥐어보는 소박한 목검. 볼품없어 보이지만, 이 검으로 시작한 전설이 한둘이 아니다.' },
    { id: 'steel-blade', icon: '⚔️', tier: '커먼', rarity: 'common', name: '단조 강철검 "브레이브하트"', price: 260000,
      desc: '숙련된 대장장이가 천 번을 두드려 만든 강철검. 손에 쥐는 순간 심장이 뜨거워진다.' },
    { id: 'ring-of-flame', icon: '💍', tier: '레어', rarity: 'rare', name: '불꽃심장의 반지', price: 480000,
      desc: '착용자의 의지가 약해질 때마다 은은한 열기를 내뿜어 다시 일으켜 세운다는 전설의 반지.' },
    { id: 'shadow-cloak', icon: '🧥', tier: '레어', rarity: 'rare', name: '그림자 망토', price: 650000,
      desc: '어둠 속에서 짜여진 망토. 걸치는 순간 발걸음이 가벼워지고, 방해되는 유혹들이 눈에 띄지 않게 된다.' },
    { id: 'dragon-heart', icon: '❤️‍🔥', tier: '에픽', rarity: 'epic', name: '용의 심장 목걸이', price: 1250000,
      desc: '잠든 고룡의 심장에서 떨어져 나온 파편. 목에 거는 순간 끝없는 지구력이 샘솟는다.' },
    { id: 'thunder-spear', icon: '🔱', tier: '에픽', rarity: 'epic', name: '뇌전을 두른 창 "제우스의 분노"', price: 1980000,
      desc: '벼락이 내려친 자리에서만 발견된다는 신화의 창. 내지르는 순간 천둥이 함께 울린다.' },
    { id: 'ice-crown', icon: '👑', tier: '에픽', rarity: 'epic', name: '얼음여왕의 왕관', price: 2750000,
      desc: '천 년 동안 얼음 성에 잠들어 있던 왕관. 쓰는 자에게 흔들리지 않는 냉철한 집중력을 선사한다.' },
    { id: 'phoenix-feather', icon: '🪶', tier: '레전더리', rarity: 'legendary', name: '불사조의 깃털', price: 3600000,
      desc: '타버려도 다시 태어나는 불사조의 깃털 한 장. 아무리 지쳐도 다시 일어날 수 있다는 증표.' },
    { id: 'primordial-shield', icon: '🛡️', tier: '레전더리', rarity: 'legendary', name: '태초의 방패 "부동석"', price: 5200000,
      desc: '세상이 갈라지던 태초의 순간부터 존재했다는 방패. 그 무엇도 이 방패 앞에서는 흔들 수 없다.' },
    { id: 'chrono-blade', icon: '⏳', tier: '신화', rarity: 'mythic', name: '시공을 가르는 검 "크로노브레이커"', price: 7400000,
      desc: '휘두르는 순간 시간의 흐름이 잠시 멈춘다는 검. 오직 극소수의 용사만이 다뤄본 적 있다.' },
    { id: 'chaos-essence', icon: '🔮', tier: '신화', rarity: 'mythic', name: '혼돈의 정수', price: 8800000,
      desc: '세계의 균열에서 흘러나온 순수한 혼돈의 결정체. 다루는 이의 한계를 재정의한다.' },
    { id: 'apocalypse-seal', icon: '🌌', tier: '신화', rarity: 'mythic', name: '종말의 인장', price: 15000000,
      desc: '모든 것의 끝과 시작을 동시에 상징하는 궁극의 인장. 손에 넣는 자, 전설 그 자체가 된다.' },
  ];

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
    let reward = 0;
    for (let i = 0; i < blocks; i++) reward += randomInt(5000, 20000);

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

  /* ---------------- Shop ---------------- */
  let selectedShopItemId = null;

  function renderShop() {
    shopItemGrid.innerHTML = '';
    shopBadge.textContent = `${SHOP_ITEMS.length}개`;

    SHOP_ITEMS.forEach((item) => {
      const node = shopItemTpl.content.cloneNode(true);
      const btn = node.querySelector('.shop-item');
      btn.querySelector('.icon-frame').classList.add(`rarity-${item.rarity}`);
      btn.querySelector('.icon-frame-glyph').textContent = item.icon;
      btn.querySelector('.shop-item-name').textContent = item.name;
      btn.querySelector('.shop-item-price-value').textContent = item.price.toLocaleString('ko-KR');
      if (selectedShopItemId === item.id) btn.classList.add('selected');
      if (inventory[item.id]) btn.classList.add('owned');
      btn.addEventListener('click', () => {
        selectedShopItemId = item.id;
        renderShop();
        renderShopDetail();
      });
      btn.dataset.id = item.id;
      shopItemGrid.appendChild(node);
    });
  }

  function renderShopDetail() {
    const item = SHOP_ITEMS.find((i) => i.id === selectedShopItemId);
    if (!item) {
      shopDetailEmpty.style.display = 'block';
      shopDetailContent.style.display = 'none';
      return;
    }
    shopDetailEmpty.style.display = 'none';
    shopDetailContent.style.display = 'flex';
    shopDetailIcon.className = `shop-detail-icon icon-frame rarity-${item.rarity}`;
    el('shopDetailIconGlyph').textContent = item.icon;
    shopDetailName.textContent = item.name;
    shopDetailTier.textContent = `${item.tier} 등급${inventory[item.id] ? ` · 보유 x${inventory[item.id]}` : ''}`;
    shopDetailDesc.textContent = item.desc;
    shopDetailPrice.textContent = item.price.toLocaleString('ko-KR');
    const canAfford = gold >= item.price;
    shopBuyBtn.disabled = !canAfford;
    shopBuyBtn.textContent = canAfford ? '구매하기' : '골드가 부족해요';
    shopBuyMsg.textContent = '';
  }

  shopBuyBtn.addEventListener('click', () => {
    const item = SHOP_ITEMS.find((i) => i.id === selectedShopItemId);
    if (!item || gold < item.price) return;
    gold -= item.price;
    save(STORE_KEYS.gold, gold);
    inventory[item.id] = (inventory[item.id] || 0) + 1;
    save(STORE_KEYS.inventory, inventory);
    renderGold();
    renderShop();
    renderShopDetail();
    renderInventory();
    showToast(`🎉 [${item.name}]을(를) 구매했어요!`);
  });

  /* ---------------- Inventory ---------------- */
  function renderInventory() {
    const ownedIds = Object.keys(inventory).filter((id) => inventory[id] > 0);
    inventoryBadge.textContent = `${ownedIds.length}개`;
    inventoryGrid.innerHTML = '';
    inventoryEmpty.style.display = ownedIds.length ? 'none' : 'block';

    ownedIds.forEach((id) => {
      const item = SHOP_ITEMS.find((i) => i.id === id);
      if (!item) return;
      const node = inventoryItemTpl.content.cloneNode(true);
      node.querySelector('.icon-frame').classList.add(`rarity-${item.rarity}`);
      node.querySelector('.icon-frame-glyph').textContent = item.icon;
      node.querySelector('.inventory-item-name').textContent = item.name;
      node.querySelector('.inventory-item-qty').textContent = `x${inventory[id]}`;
      inventoryGrid.appendChild(node);
    });
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
    if (activeSession) startTicking();
    renderShop();
    renderShopDetail();
    renderInventory();
  }

  init();
})();
