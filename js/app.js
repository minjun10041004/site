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
  // The app_data row's updated_at as of our last load/save -- lets flushSave()
  // detect "someone else (another tab/device) saved after us" instead of
  // blindly overwriting a newer save with this tab's possibly-stale state.
  let lastKnownUpdatedAt = null;

  let schedules = [];
  let todosByDate = {};
  let examChecklist = []; // { id, text, done, subjectId } — a flat list, not date-scoped
  let happinessByDate = {}; // { [dateKey]: [{ id, text, createdAt }] } — 칭찬/감사 일기, resets daily like todos
  let examSubjects = []; // { id, name } — user-defined tabs to split the checklist by subject
  let activeExamSubjectId = null; // null = "전체" (shows every item, tagged or not)
  let subjects = [];
  let studyByDate = {};
  let activeSession = null;
  let nickname = '';       // shown on the leaderboard instead of the account id, once set
  let avatar = null;       // small data URL, or null for the placeholder icon

  /* ---------------- 네벨라크 성장/재화 상태 ----------------
     2026-09 개편으로 무협 시대의 경지/검/장비/강화 데이터(골드 포함)는
     전부 폐기한다 — 사용자 요청에 따라 이전 값은 그대로 삭제되고, 공부
     기록(studyByDate/subjects 등, 위 섹션)만 유지된다. 아래는 전부 이
     개편 이후 기본값에서 새로 시작한다. */
  let gold = 0;                    // 성휘 (기존 골드 변수명을 그대로 재사용)
  let resonanceFragments = 0;      // 공명 파편
  let starCores = 0;               // 성핵
  let constellationSeals = 0;      // 별자리 인장
  // 'practice-sword' 문자열 리터럴을 직접 쓰는 이유: PRACTICE_SWORD 상수는
  // 파일 뒤쪽(검 도감 섹션)에서 선언되므로, 최상위 스코프에서 바로 실행되는
  // 이 초기값 대입 시점에는 아직 TDZ(temporal dead zone) 안에 있어
  // PRACTICE_SWORD.id로 참조하면 throw 한다.
  let equippedSwordId = 'practice-sword';
  let discoveredSwordIds = ['practice-sword'];
  let swordEnhanceLv = {};         // { [swordId]: 0-10 }
  let swordResonanceMin = {};      // { [swordId]: 누적 실공부 분 (해당 검 장착 중일 때만 누적) }
  let swordResonanceStage = {};    // { [swordId]: 0-4 } — 공부시간 충족 후 파편·성핵을 써서 확정한 단계
  let pityStreak = {};             // { [PITY_RULES.key]: 연속 미달 횟수 }
  let claimedDailyQuests = {};     // { [dateKey]: questId[] }
  let claimedWeeklyQuests = {};    // { [weekKey]: questId[] }
  let claimedRegions = [];         // 해금 보상을 수령한 지역 id[]
  let activeEpithetSwordId = null; // 프로필에 대표로 표시할 별호의 검 id
  let totalSummons = 0;            // 누적 소환 횟수
  let boostRemainingSeconds = 0;   // 성휘 부스트 -- 남은 2배 적용 실측정 시간(초)
  let boostGrantedOnce = false;    // 계정당 1회, 최근 30일 공부시간 기준 부스트를 이미 지급했는지

  // 2026-09 네벨라크 개편 저장 포맷 버전. 이 값이 없거나 다르면(=개편 이전
  // 무협 시대 저장분) 아래 성장/재화 필드는 전부 기본값에서 새로 시작한다.
  // gold처럼 이전 시스템과 같은 필드명을 그대로 재사용하는 값이 있어서,
  // 이 버전 검사 없이는 옛 골드(예: 9,999,999)가 새 성휘 잔액으로 그대로
  // 새어 들어오는 사고가 난다 -- 실제로 테스트에서 이 문제를 발견해 추가함.
  const NEVELAC_STATE_VERSION = 1;

  function collectState() {
    return {
      schedules, todosByDate, examChecklist, examSubjects, happinessByDate, subjects, studyByDate, activeSession,
      nickname, avatar,
      nevelacVersion: NEVELAC_STATE_VERSION,
      gold, resonanceFragments, starCores, constellationSeals,
      equippedSwordId, discoveredSwordIds, swordEnhanceLv, swordResonanceMin, swordResonanceStage, pityStreak,
      claimedDailyQuests, claimedWeeklyQuests, claimedRegions, activeEpithetSwordId, totalSummons,
      boostRemainingSeconds, boostGrantedOnce,
    };
  }

  function applyState(data) {
    schedules = data.schedules ?? [];
    todosByDate = data.todosByDate ?? {};
    examChecklist = Array.isArray(data.examChecklist) ? data.examChecklist : [];
    examSubjects = Array.isArray(data.examSubjects) ? data.examSubjects : [];
    happinessByDate = data.happinessByDate ?? {};
    subjects = data.subjects ?? [];
    studyByDate = data.studyByDate ?? {};
    activeSession = data.activeSession ?? null;

    nickname = typeof data.nickname === 'string' ? data.nickname.slice(0, 16) : '';
    avatar = isSafeAvatarUrl(data.avatar) ? data.avatar : null;

    const validSwordId = (id) => id === PRACTICE_SWORD.id || !!nebelacSwordById(id);
    // 개편 이전 저장분은 nevelacVersion이 없으므로 nebelac이 빈 객체({})를
    // 넘겨받은 것처럼 취급한다 -- 아래 모든 Number.isFinite/typeof 검사가
    // 자연스럽게 실패해 기본값으로 떨어진다.
    const nebelac = data.nevelacVersion === NEVELAC_STATE_VERSION ? data : {};

    gold = Number.isFinite(nebelac.gold) ? Math.max(0, Math.floor(nebelac.gold)) : 0;
    resonanceFragments = Number.isFinite(nebelac.resonanceFragments) ? Math.max(0, Math.floor(nebelac.resonanceFragments)) : 0;
    starCores = Number.isFinite(nebelac.starCores) ? Math.max(0, Math.floor(nebelac.starCores)) : 0;
    constellationSeals = Number.isFinite(nebelac.constellationSeals) ? Math.max(0, Math.floor(nebelac.constellationSeals)) : 0;
    totalSummons = Number.isFinite(nebelac.totalSummons) ? Math.max(0, Math.floor(nebelac.totalSummons)) : 0;

    // 성휘 부스트: 계정당 딱 한 번, "지금 기준"(이 저장분을 처음 불러오는
    // 순간) 최근 30일 공부시간을 그대로 부스트 예산으로 지급한다. 반복
    // 발동 가능한 버튼이 아니라 일회성 업데이트이므로, boostGrantedOnce가
    // 아직 없는 계정(기존 유저 전원 포함)에서만 한 번 지급하고 바로
    // 플래그를 세운다 -- 이후 로그인/새로고침에서는 다시 지급되지 않는다.
    boostGrantedOnce = !!nebelac.boostGrantedOnce;
    if (!boostGrantedOnce) {
      boostRemainingSeconds = sumStudySecondsRolling(30);
      boostGrantedOnce = true;
    } else {
      boostRemainingSeconds = Number.isFinite(nebelac.boostRemainingSeconds) ? Math.max(0, Math.floor(nebelac.boostRemainingSeconds)) : 0;
    }

    equippedSwordId = validSwordId(nebelac.equippedSwordId) ? nebelac.equippedSwordId : PRACTICE_SWORD.id;
    discoveredSwordIds = Array.isArray(nebelac.discoveredSwordIds)
      ? [...new Set(nebelac.discoveredSwordIds.filter(validSwordId))]
      : [];
    if (!discoveredSwordIds.includes(PRACTICE_SWORD.id)) discoveredSwordIds.unshift(PRACTICE_SWORD.id);
    if (!discoveredSwordIds.includes(equippedSwordId)) discoveredSwordIds.push(equippedSwordId);

    swordEnhanceLv = {};
    if (nebelac.swordEnhanceLv && typeof nebelac.swordEnhanceLv === 'object') {
      for (const id of Object.keys(nebelac.swordEnhanceLv)) {
        const lv = Math.floor(nebelac.swordEnhanceLv[id]);
        if (validSwordId(id) && Number.isFinite(lv) && lv > 0) {
          swordEnhanceLv[id] = Math.min(ENHANCE_MAX_LEVEL, lv);
        }
      }
    }

    swordResonanceMin = {};
    if (nebelac.swordResonanceMin && typeof nebelac.swordResonanceMin === 'object') {
      for (const id of Object.keys(nebelac.swordResonanceMin)) {
        const min = Number(nebelac.swordResonanceMin[id]);
        if (validSwordId(id) && Number.isFinite(min) && min > 0) {
          swordResonanceMin[id] = min;
        }
      }
    }

    swordResonanceStage = {};
    if (nebelac.swordResonanceStage && typeof nebelac.swordResonanceStage === 'object') {
      for (const id of Object.keys(nebelac.swordResonanceStage)) {
        const stage = Math.floor(nebelac.swordResonanceStage[id]);
        if (validSwordId(id) && Number.isFinite(stage) && stage > 0) {
          swordResonanceStage[id] = Math.min(RESONANCE_MAX_STAGE, stage);
        }
      }
    }

    pityStreak = {};
    if (nebelac.pityStreak && typeof nebelac.pityStreak === 'object') {
      for (const rule of PITY_RULES) {
        const v = Math.floor(nebelac.pityStreak[rule.key]);
        pityStreak[rule.key] = Number.isFinite(v) && v > 0 ? v : 0;
      }
    } else {
      for (const rule of PITY_RULES) pityStreak[rule.key] = 0;
    }

    const validQuestIds = new Set([...DAILY_QUESTS.map((q) => q.id), ...WEEKLY_QUESTS.map((q) => q.id)]);
    claimedDailyQuests = {};
    if (nebelac.claimedDailyQuests && typeof nebelac.claimedDailyQuests === 'object') {
      for (const dateKey of Object.keys(nebelac.claimedDailyQuests)) {
        const list = nebelac.claimedDailyQuests[dateKey];
        if (Array.isArray(list)) claimedDailyQuests[dateKey] = list.filter((id) => validQuestIds.has(id));
      }
    }
    claimedWeeklyQuests = {};
    if (nebelac.claimedWeeklyQuests && typeof nebelac.claimedWeeklyQuests === 'object') {
      for (const weekKey of Object.keys(nebelac.claimedWeeklyQuests)) {
        const list = nebelac.claimedWeeklyQuests[weekKey];
        if (Array.isArray(list)) claimedWeeklyQuests[weekKey] = list.filter((id) => validQuestIds.has(id));
      }
    }

    const validRegionIds = new Set(JOURNEY_REGIONS.map((r) => r.id));
    claimedRegions = Array.isArray(nebelac.claimedRegions)
      ? [...new Set(nebelac.claimedRegions.filter((id) => validRegionIds.has(id)))]
      : [];

    activeEpithetSwordId = typeof nebelac.activeEpithetSwordId === 'string' && nebelacSwordById(nebelac.activeEpithetSwordId)
      ? nebelac.activeEpithetSwordId
      : null;
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

  // 검 도감 전체 중 실제로 보유한 종수 (시작 검 무명의 연습검은 수집 대상이 아님).
  function nebelacDiscoveredCount() {
    return discoveredSwordIds.filter((id) => id !== PRACTICE_SWORD.id).length;
  }
  // 보유한 검 중 도달한 최고 공명 단계 (0=고요 ~ 4=완전공명).
  function maxResonanceStage() {
    let max = 0;
    for (const id of discoveredSwordIds) {
      if (id === PRACTICE_SWORD.id) continue;
      max = Math.max(max, resonanceStageIndexFor(id));
    }
    return max;
  }

  function leaderboardRow() {
    return {
      user_id: currentUserId,
      username: currentUsername,
      nickname: nickname || null,
      avatar,
      study_today: sumStudySecondsForDate(studyDayKey()),
      study_week: sumStudySecondsRolling(7),
      study_month: sumStudySecondsRolling(30),
      study_total: sumStudySecondsAllTime(),
      sword_collection: nebelacDiscoveredCount(),
      max_resonance_stage: maxResonanceStage(),
      updated_at: new Date().toISOString(),
    };
  }

  async function flushSave() {
    if (!currentUserId) return;

    // Optimistic-concurrency guard: if another tab/device saved after we
    // last loaded or saved, this tab's in-memory state is stale -- pushing
    // it now would silently roll back whatever that newer save had. Refuse
    // instead of clobbering; the user can reload to pick up the latest.
    if (lastKnownUpdatedAt) {
      const { data: current } = await sb.from('app_data')
        .select('updated_at').eq('user_id', currentUserId).maybeSingle();
      const serverTime = current?.updated_at ? new Date(current.updated_at).getTime() : null;
      const knownTime = new Date(lastKnownUpdatedAt).getTime();
      if (serverTime !== null && serverTime !== knownTime) {
        showToast('⚠️ 다른 기기/탭에서 더 최근에 저장된 데이터가 있어 자동저장을 건너뛰었어요. 새로고침해서 최신 상태를 불러와주세요.');
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const [, { error: rankError }] = await Promise.all([
      sb.from('app_data').upsert({
        user_id: currentUserId,
        data: collectState(),
        updated_at: nowIso,
      }),
      sb.from('leaderboard').upsert(leaderboardRow()),
    ]);
    lastKnownUpdatedAt = nowIso;
    // total_draws is a new column — until the matching migration has been
    // run, upserting it fails the whole row (not just that field), which
    // would otherwise silently stop gold/study time from reaching the
    // leaderboard too. Retry once without it so everything else still
    // syncs in the meantime.
    if (rankError) {
      // study_total/sword_collection/max_resonance_stage are new columns —
      // until the matching migration has run on the DB, upserting them
      // fails the whole row (not just those fields), which would otherwise
      // silently stop study_today/week/month from reaching the leaderboard
      // too. Retry once without them so everything else still syncs.
      const { study_total, sword_collection, max_resonance_stage, ...withoutNewCols } = leaderboardRow();
      await sb.from('leaderboard').upsert(withoutNewCols);
    }
  }

  let saveTimer = null;
  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 500);
  }
  // A pending save can still be sitting in the 500ms debounce window when
  // the tab/app goes away -- study minutes and gold from a just-finished
  // session are exactly the kind of state that lives there. 'beforeunload'
  // alone isn't enough to catch that: it doesn't fire at all on iOS Safari
  // or when a mobile app is backgrounded/killed rather than closed via
  // browser chrome, and even where it does fire, the fetch flushSave()
  // kicks off is not guaranteed to finish before the page is torn down.
  // 'visibilitychange' -> hidden fires reliably in both cases (tab switch,
  // app backgrounding, screen lock) *before* teardown, while the page is
  // still alive to let the request land; 'pagehide' catches actual
  // navigation/close more reliably than 'beforeunload' on mobile. All three
  // funnel into the same immediate flush, cancelling the debounce so nothing
  // double-fires pointlessly.
  function flushSaveIfPending() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    flushSave();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaveIfPending();
  });
  window.addEventListener('pagehide', flushSaveIfPending);
  window.addEventListener('beforeunload', flushSaveIfPending);

  async function loadUserState() {
    const { data } = await sb.from('app_data').select('data, updated_at').eq('user_id', currentUserId).maybeSingle();
    applyState(data && data.data ? data.data : {});
    lastKnownUpdatedAt = data?.updated_at ?? null;
    // Always resync the leaderboard row on load, not just for brand-new
    // users: study_today/week/month are snapshots written by flushSave(),
    // so a device that was closed across the 5am study-day boundary and
    // reopened later would otherwise keep showing yesterday's number on
    // every ranking tab until some unrelated action happened to save.
    await flushSave();
  }

  const EXAM_TARGET_DATE = '2026-09-29';

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

  const examDdayEl = el('examDday');

  const examSubjectTabsEl = el('examSubjectTabs');
  const examSubjectForm = el('examSubjectForm');
  const examSubjectTextInput = el('examSubjectText');

  const examChecklistForm = el('examChecklistForm');
  const examChecklistTextInput = el('examChecklistText');
  const examChecklistList = el('examChecklistList');
  const examChecklistEmpty = el('examChecklistEmpty');
  const examChecklistBadge = el('examChecklistBadge');
  const examChecklistItemTpl = el('examChecklistItemTemplate');

  const happinessHeroCard = el('happinessHeroCard');
  const happinessEffectLayer = el('happinessEffectLayer');
  const happinessIndexEl = el('happinessIndex');
  const happinessTierNameEl = el('happinessTierName');
  const happinessTierHintEl = el('happinessTierHint');
  const happinessForm = el('happinessForm');
  const happinessTextInput = el('happinessText');
  const happinessList = el('happinessList');
  const happinessEmpty = el('happinessEmpty');
  const happinessBadge = el('happinessBadge');
  const happinessItemTpl = el('happinessItemTemplate');

  const themeSwitch = el('themeSwitch');

  const goldAmountEl = el('goldAmount');
  const topCoreAmountEl = el('topCoreAmount');
  const topSealAmountEl = el('topSealAmount');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    main: el('panel-main'),
    study: el('panel-study'),
    journey: el('panel-journey'),
    hall: el('panel-hall'),
    growth: el('panel-growth'),
    codex: el('panel-codex'),
    record: el('panel-record'),
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
  const adjustCancelBtn = el('adjustCancelBtn');
  const timerHint = el('timerHint');
  const todayTotalDisplay = el('todayTotalDisplay');
  const subjectBadge = el('subjectBadge');
  const subjectList = el('subjectList');
  const subjectEmpty = el('subjectEmpty');
  const subjectForm = el('subjectForm');
  const subjectTextInput = el('subjectText');
  const subjectItemTpl = el('subjectItemTemplate');

  const avatarCircle = el('avatarCircle');
  const avatarImg = el('avatarImg');
  const avatarPlaceholder = el('avatarPlaceholder');
  const avatarInput = el('avatarInput');
  const nicknameForm = el('nicknameForm');
  const nicknameInput = el('nicknameInput');
  const profileSword = el('profileSword');
  const profileEpithetSelect = el('profileEpithetSelect');
  const profileEpithetValue = el('profileEpithetValue');
  const profileGold = el('profileGold');
  const profileCores = el('profileCores');
  const profileSeals = el('profileSeals');
  const profileTodayStudy = el('profileTodayStudy');
  const profileWeekStudy = el('profileWeekStudy');
  const profileTotalStudy = el('profileTotalStudy');
  const profileCollection = el('profileCollection');
  const profileMaxResonance = el('profileMaxResonance');
  const profileStreak = el('profileStreak');
  const profileRankList = el('profileRankList');

  const myRankEl = el('myRank');
  const rankCategoryButtons = Array.from(document.querySelectorAll('.rank-cat-btn'));
  const rankList = el('rankList');
  const rankEmpty = el('rankEmpty');
  const rankRowTpl = el('rankRowTemplate');

  const toastEl = el('toast');

  /* ---------------- 검의 전당 (소환 + 보유 검) ---------------- */
  const hallEquippedGrade = el('hallEquippedGrade');
  const hallEquippedName = el('hallEquippedName');
  const hallEquippedTitle = el('hallEquippedTitle');
  const hallEquippedImg = el('hallEquippedImg');
  const hallEquippedPlaceholder = el('hallEquippedPlaceholder');
  const hallEquippedLore = el('hallEquippedLore');
  const hallEquippedDesc = el('hallEquippedDesc');
  const hallEquippedIncome = el('hallEquippedIncome');
  const hallEquippedEnhanceBadge = el('hallEquippedEnhanceBadge');
  const hallEquippedResonanceBadge = el('hallEquippedResonanceBadge');
  const summonCostSingle = el('summonCostSingle');
  const summonCostTen = el('summonCostTen');
  const summonBtn1 = el('summonBtn1');
  const summonBtn10 = el('summonBtn10');
  const summonResults = el('summonResults');
  const summonResultsEmpty = el('summonResultsEmpty');
  const gradeChanceTable = el('gradeChanceTable');
  const pityList = el('pityList');
  const hallOwnedList = el('hallOwnedList');
  const hallOwnedCount = el('hallOwnedCount');
  const hallOwnedEmpty = el('hallOwnedEmpty');
  const sealBalance = el('sealBalance');
  const sealRedeemList = el('sealRedeemList');
  const swordResultTpl = el('swordResultTemplate');

  /* ---------------- 성장 (강화 · 공명 · 유물함) ---------------- */
  const growthSubtabs = el('growthSubtabs');
  const growthPanels = {
    enhance: el('growth-enhance'),
    resonance: el('growth-resonance'),
    relics: el('growth-relics'),
  };
  const growthEnhanceSelect = el('growthEnhanceSelect');
  const growthEnhanceDisplay = el('growthEnhanceDisplay');
  const growthEnhanceBadgeArt = el('growthEnhanceBadgeArt');
  const growthEnhanceEmpty = el('growthEnhanceEmpty');
  const growthEnhanceGrade = el('growthEnhanceGrade');
  const growthEnhanceName = el('growthEnhanceName');
  const growthEnhanceLevel = el('growthEnhanceLevel');
  const growthEnhanceIncome = el('growthEnhanceIncome');
  const growthEnhanceNextInfo = el('growthEnhanceNextInfo');
  const growthEnhanceBtn = el('growthEnhanceBtn');
  const growthResonanceSelect = el('growthResonanceSelect');
  const growthResonanceDisplay = el('growthResonanceDisplay');
  const growthResonanceEmpty = el('growthResonanceEmpty');
  const growthResonanceGrade = el('growthResonanceGrade');
  const growthResonanceName = el('growthResonanceName');
  const growthResonanceStageName = el('growthResonanceStageName');
  const growthResonanceProgress = el('growthResonanceProgress');
  const growthResonanceNextInfo = el('growthResonanceNextInfo');
  const growthResonanceBtn = el('growthResonanceBtn');
  const growthRelicsList = el('growthRelicsList');
  const growthRelicsEmpty = el('growthRelicsEmpty');

  /* ---------------- 도감 ---------------- */
  const codexGrid = el('codexGrid');
  const codexProgress = el('codexProgress');
  const codexCardTpl = el('codexCardTemplate');
  const codexShowcase = el('codexShowcase');
  const codexShowcaseImg = el('codexShowcaseImg');
  const codexShowcasePlaceholder = el('codexShowcasePlaceholder');
  const codexShowcaseGrade = el('codexShowcaseGrade');
  const codexShowcaseName = el('codexShowcaseName');
  const codexShowcaseTitle = el('codexShowcaseTitle');
  const codexShowcaseEnhance = el('codexShowcaseEnhance');
  const codexShowcaseResonance = el('codexShowcaseResonance');
  const codexShowcaseLore = el('codexShowcaseLore');
  const codexShowcaseDesc = el('codexShowcaseDesc');
  const codexShowcaseIncome = el('codexShowcaseIncome');
  const codexShowcaseClose = el('codexShowcaseClose');

  /* ---------------- 여정 ---------------- */
  const journeyCumulative = el('journeyCumulative');
  const journeyCores = el('journeyCores');
  const journeySeals = el('journeySeals');
  const journeyDailyList = el('journeyDailyList');
  const journeyWeeklyList = el('journeyWeeklyList');
  const journeyRegionBadge = el('journeyRegionBadge');
  const regionPrevBtn = el('regionPrevBtn');
  const regionNextBtn = el('regionNextBtn');
  const regionSlide = el('regionSlide');
  const regionImg = el('regionImg');
  const regionPlaceholder = el('regionPlaceholder');
  const regionName = el('regionName');
  const regionDesc = el('regionDesc');
  const regionStatus = el('regionStatus');
  const regionClaimBtn = el('regionClaimBtn');
  const journeyAchievementList = el('journeyAchievementList');
  const boostBadge = el('boostBadge');
  const boostDesc = el('boostDesc');

  /* ---------------- 기록 (행복 + 업적) ---------------- */
  const recordAchievementList = el('recordAchievementList');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 60;

  /* ================================================================
     네벨라크 (Nevelac) — 판타지 성장·수집·경제 시스템
     ================================================================ */

  /* ---------------- 재화 기본값 ---------------- */
  // 분당 성휘의 고정 기본값. 실제 분당 수입 = BASE_INCOME_PER_MIN + 장착검 효율.
  const BASE_INCOME_PER_MIN = 600;

  /* ---------------- 검 등급 (잔광급~원초급) ----------------
     인덱스 0-7 그대로 기존 rar-0..rar-7 CSS 색상을 재사용한다 (회색 →
     초록 → 파랑 → 보라 → 청록 → 금색 → 진홍 → 흑요석 순으로, 등급이
     오를수록 색이 진해지는 기존 배색이 이 8단계에도 그대로 맞는다). */
  const SWORD_GRADES = [
    { key: 'janggwang',  name: '잔광급', hanja: '殘光級', chance: 45,
      meaning: '특별한 힘의 흔적만 남은 유물' },
    { key: 'gakseong',   name: '각성급', hanja: '覺醒級', chance: 25,
      meaning: '특정 능력이 깨어난 마법 무기' },
    { key: 'seongyu',    name: '성유급', hanja: '聖遺級', chance: 15,
      meaning: '성스러운 사건이나 영웅의 유산' },
    { key: 'yongmaek',   name: '용맥급', hanja: '龍脈級', chance: 8,
      meaning: '용, 대지, 심해 등 거대한 생명력과 연결된 무기' },
    { key: 'geumseo',    name: '금서급', hanja: '禁書級', chance: 4.5,
      meaning: '사용에 대가가 따르는 금지된 무기' },
    { key: 'wangwan',    name: '왕관급', hanja: '王冠級', chance: 1.8,
      meaning: '왕, 지배자, 권능을 무너뜨리거나 빼앗는 무기' },
    { key: 'cheonseong', name: '천성급', hanja: '天星級', chance: 0.65,
      meaning: '별, 태양, 시간, 천체와 연결된 무기' },
    { key: 'woncho',     name: '원초급', hanja: '原初級', chance: 0.05,
      meaning: '세계가 생기기 전부터 존재한 근원적인 무기' },
  ];
  // 중복 획득 시 공명 파편으로 전환되는 양 (등급 인덱스 순).
  const DUPLICATE_FRAGMENTS_BY_GRADE = [2, 4, 9, 20, 45, 100, 250, 1000];

  /* 천명 게이지 — 해당 등급 이상을 이 횟수만큼 연속으로 못 뽑으면 다음
     소환에서 확정 지급. 원초급은 보장 없음 (별자리 인장으로만 확정 획득). */
  const PITY_RULES = [
    { minGradeIdx: 1, streak: 10,  key: 'gakseong' },   // 각성급 이상
    { minGradeIdx: 2, streak: 30,  key: 'seongyu' },    // 성유급 이상
    { minGradeIdx: 3, streak: 80,  key: 'yongmaek' },   // 용맥급 이상
    { minGradeIdx: 4, streak: 200, key: 'geumseo' },    // 금서급 이상
    { minGradeIdx: 6, streak: 500, key: 'cheonseong' }, // 천성급 이상
  ];

  const SUMMON_COST_SINGLE = 50000;
  const SUMMON_COST_TEN = 450000;

  /* 시작 검 — 소환 대상이 아니며 도감/중복 전환에도 포함되지 않는다. */
  const PRACTICE_SWORD = {
    id: 'practice-sword', name: '무명의 연습검', title: '첫 걸음을 뗀 자',
    grade: null, image: 'img/practice-sword.png', imageAlt: '', baseIncome: 180,
    lore: '이름조차 새겨지지 않은 평범한 연습용 목검. 네벨라크의 모든 검사는 이 검에서 첫걸음을 뗀다.',
    desc: '화려한 힘은 없지만, 균열 너머의 세계에서 살아남기 위한 첫 번째 자격을 시험한다.',
  };

  /* ---------------- 검 도감 (42종, 등급 순) ----------------
     id는 저장 데이터의 고유 키 — 배열 순서가 바뀌어도 보유/장착/강화/공명
     상태는 이 id를 기준으로 유지된다. */
  const NEBELAC_SWORDS = [
    /* ---- 잔광급 ---- */
    { id: 'frost-needle-prism', name: '서리송곳 프리즘', title: '한순간을 얼린 바늘',
      grade: 'janggwang', image: 'img/frost-needle-prism.png', imageAlt: '', baseIncome: 220,
      lore: '검끝에 찔린 대상의 시간이 얼어붙어 움직임이 느려진다.',
      desc: '칼날은 얇고 투명하며, 검이 지나간 자리에는 금이 간 유리 같은 서리가 남는다.' },
    { id: 'ink-tome-relic', name: '잔서검 이레실', title: '읽은 것은 잊지 않는다',
      grade: 'janggwang', image: 'img/ink-tome-relic.png', imageAlt: '', baseIncome: 250,
      lore: '검신에 스친 글귀는 그대로 칼날에 새겨져 사라지지 않는다.',
      desc: '낡은 서고에서 발견된 얇은 단검으로, 벤 자리마다 옛 문헌의 글자가 순간적으로 떠올랐다 사라진다.' },
    { id: 'lost-road-compass', name: '미로향검 벨나크', title: '모든 길은 결국 여기로',
      grade: 'janggwang', image: 'img/lost-road-compass.png', imageAlt: '', baseIncome: 290,
      lore: '방향을 잃은 자가 쥐면 검끝이 가장 가까운 안전한 길을 가리킨다.',
      desc: '손잡이에 작은 나침반이 박혀 있으며, 바늘은 북쪽이 아니라 사용자가 진짜 원하는 곳을 향해 흔들린다.' },
    { id: 'obsidian-ember-shard', name: '흑요잔편검 카른헬', title: '타버린 세상의 마지막 조각',
      grade: 'janggwang', image: 'img/obsidian-ember-shard.png', imageAlt: '', baseIncome: 330,
      lore: '벤 자리는 순간적으로 새까맣게 그을리지만 금세 원래대로 돌아온다.',
      desc: '화산재 속에 묻혀 있던 검은 유리 조각을 이어붙인 검으로, 칼날 표면에 아직도 옛 불길의 흔적이 어른거린다.' },

    /* ---- 각성급 ---- */
    { id: 'shadow-twin-nocturne', name: '그림자쌍검 노크턴', title: '그림자가 먼저 죽는다',
      grade: 'gakseong', image: 'img/shadow-twin-nocturne.png', imageAlt: '', baseIncome: 360,
      lore: '한 자루는 현실을, 다른 한 자루는 그림자를 벤다.',
      desc: '두 검을 함께 휘두르면 적의 그림자가 먼저 쓰러지고, 본체는 뒤늦게 상처를 입는다.' },
    { id: 'glass-mirage', name: '유리검 미라지', title: '거울 속의 적',
      grade: 'gakseong', image: 'img/glass-mirage.png', imageAlt: '', baseIncome: 390,
      lore: '검에 비친 상대의 모습이 허상이 되어 전장을 어지럽힌다.',
      desc: '검에 비친 가짜 모습은 실제 움직임보다 반 박자 빠르게 움직인다.' },
    { id: 'nightmare-invitation', name: '몽마의 초대장, 나이트메어', title: '잠든 자의 초대',
      grade: 'gakseong', image: 'img/nightmare-invitation.png', imageAlt: '', baseIncome: 420,
      lore: '적의 꿈속에 들어가 정신을 공격하는 검이다.',
      desc: '현실에서는 짧은 단검에 불과하지만, 꿈속에서는 거대한 낫으로 변해 상대의 공포를 직접 베어낸다.' },
    { id: 'silent-toll-bell', name: '적요종검 카시엘', title: '울리는 순간 세상이 멈춘다',
      grade: 'gakseong', image: 'img/silent-toll-bell.png', imageAlt: '', baseIncome: 450,
      lore: '휘두르면 짧은 종소리가 울리고, 그 반경 안의 모든 소리가 한 박자 사라진다.',
      desc: '검신 대신 작은 종이 매달린 기묘한 형태로, 전장에서 이 검을 든 자의 발소리조차 들리지 않는다.' },
    { id: 'binding-oath-chain', name: '구속서약검 오르실', title: '자유를 대가로 빌려주는 힘',
      grade: 'gakseong', image: 'img/binding-oath-chain.png', imageAlt: '', baseIncome: 480,
      lore: '사용자의 팔에 스스로 사슬을 감아 힘을 증폭시키지만, 전투가 끝나기 전엔 풀리지 않는다.',
      desc: '검신을 따라 가느다란 사슬 무늬가 흐르며, 오래 휘두를수록 사슬이 손목을 타고 조금씩 파고든다.' },
    { id: 'puppet-string-blade', name: '견사조종검 자히엘', title: '네 몸이 내 대사를 읊는다',
      grade: 'gakseong', image: 'img/puppet-string-blade.png', imageAlt: '', baseIncome: 510,
      lore: '검에 스친 자는 짧은 순간 사용자의 뜻대로 팔다리가 움직인다.',
      desc: '칼날 끝에서 거미줄처럼 가느다란 실이 뻗어 나와, 벤 상대의 관절을 따라 인형처럼 얽어맨다.' },

    /* ---- 성유급 ---- */
    { id: 'asterion-starsea', name: '성해검 아스테리온', title: '밤하늘을 휘두르는 자',
      grade: 'seongyu', image: 'img/asterion-starsea.png', imageAlt: '', baseIncome: 650,
      lore: '밤마다 검신의 별자리가 바뀌며, 완성된 별자리에 따라 다른 마법을 사용한다.',
      desc: '검을 휘두를 때마다 검신 안의 별빛이 이어져 새로운 별자리를 만든다.' },
    { id: 'astravein', name: '별먹는 자, 아스트라베인', title: '별을 삼킨 자',
      grade: 'seongyu', image: 'img/astravein.png', imageAlt: '', baseIncome: 700,
      lore: '밤하늘의 별빛을 흡수해 검신에 저장하는 성유급 검이다.',
      desc: '검을 휘두를 때마다 작은 운석이 떨어지며, 오랫동안 사용할수록 검신 안에 별 하나가 사라진다.' },
    { id: 'elysia-white-pine', name: '백색장송, 엘리시아', title: '영혼을 재우는 장송자',
      grade: 'seongyu', image: 'img/elysia-white-pine.png', imageAlt: '', baseIncome: 760,
      lore: '죽은 자의 영혼을 편히 잠들게 하는 검이다.',
      desc: '악령에게는 치명적이지만 산 자에게는 거의 피해를 주지 못한다. 검이 지나간 자리에는 눈처럼 하얀 빛이 남는다.' },
    { id: 'grail-sword', name: '성배검 그라알', title: '구원과 대가의 검',
      grade: 'seongyu', image: 'img/grail-sword.png', imageAlt: '', baseIncome: 820,
      lore: '상처를 치유할 수 있지만, 치유한 만큼 사용자의 수명이 줄어든다.',
      desc: '검신 중앙에는 성배의 파편이 박혀 있으며, 치유할 때마다 파편의 빛이 조금씩 희미해진다.' },
    { id: 'thornroot-verdant', name: '가시뿌리검 텐브라', title: '땅이 삼킨 것을 되돌린다',
      grade: 'seongyu', image: 'img/thornroot-verdant.png', imageAlt: '', baseIncome: 870,
      lore: '검을 땅에 꽂으면 그 자리에서 가시덩굴이 솟아나 적의 발을 묶는다.',
      desc: '칼날 전체가 살아있는 나무뿌리처럼 얽혀 있으며, 계절이 바뀌어도 시들지 않는 이끼가 덮여 있다.' },
    { id: 'primal-howling-beast', name: '광포태초검 벨로스', title: '이성보다 먼저 깨어나는 짐승',
      grade: 'seongyu', image: 'img/primal-howling-beast.png', imageAlt: '', baseIncome: 920,
      lore: '사용자의 심박이 빨라질수록 검이 스스로 더 크고 거칠게 울부짖는다.',
      desc: '짐승의 송곳니를 이어붙인 듯한 날카로운 날을 가졌으며, 오래 휘두를수록 손잡이에서 낮은 숨소리가 들려온다.' },

    /* ---- 용맥급 ---- */
    { id: 'balkan-thunder', name: '천뢰검 발칸', title: '폭풍이 선택한 철',
      grade: 'yongmaek', image: 'img/balkan-thunder.png', imageAlt: '', baseIncome: 1200,
      lore: '땅에 꽂으면 주변에 낙뢰 기둥이 떨어진다.',
      desc: '검을 쥔 사람도 감당하기 어려운 무게를 지녔으며, 번개의 힘이 강해질수록 검 자체가 더욱 무거워진다.' },
    { id: 'carbonea', name: '용골검 카르보네아', title: '멸종한 용의 등뼈',
      grade: 'yongmaek', image: 'img/carbonea.png', imageAlt: '', baseIncome: 1350,
      lore: '검신의 마디가 살아 움직이며, 사용자의 분노에 반응해 용의 이빨처럼 갈라진다.',
      desc: '검을 오래 사용할수록 검 안에 잠든 용의 기억이 드러난다.' },
    { id: 'dracor', name: '용의 마지막 심장, 드라코르', title: '마지막 용의 맥박',
      grade: 'yongmaek', image: 'img/dracor.png', imageAlt: '', baseIncome: 1500,
      lore: '멸종한 고대 용의 심장이 검 중앙에 박혀 있다.',
      desc: '사용자의 감정이 격해질수록 검이 용의 형태로 변하며, 분노가 극에 달하면 검신에서 용의 턱이 열린다.' },
    { id: 'leviathan-deep', name: '심해검 레비아탄', title: '바다 밑의 왕',
      grade: 'yongmaek', image: 'img/leviathan-deep.png', imageAlt: '', baseIncome: 1700,
      lore: '주변의 수분을 끌어모아 거대한 파도와 심해 압력을 만든다.',
      desc: '검이 움직일 때마다 주변 공기가 물속처럼 무거워지며, 검끝에 푸른 심해의 눈이 나타난다.' },
    { id: 'gale-cutting-wind', name: '질풍참검 노르윈', title: '스치면 이미 베인 뒤다',
      grade: 'yongmaek', image: 'img/gale-cutting-wind.png', imageAlt: '', baseIncome: 1850,
      lore: '검을 휘두르는 속도가 바람의 속도를 넘어서면 벤 흔적이 소리보다 늦게 나타난다.',
      desc: '칼날에 무수한 구멍이 뚫려 있어 휘두를 때마다 낮은 휘파람 소리를 내며, 바람을 가르는 게 아니라 바람 그 자체가 된다.' },
    { id: 'thousand-blade-dance', name: '천검군무 이스카', title: '한 자루가 아니라 천 자루다',
      grade: 'yongmaek', image: 'img/thousand-blade-dance.png', imageAlt: '', baseIncome: 2000,
      lore: '휘두르는 순간 검신이 흩어져 수백 개의 작은 칼날 무리로 변한다.',
      desc: '평소에는 평범한 장검이지만, 전투가 시작되면 벌떼처럼 흩어졌다 다시 모여 하나의 검이 된다.' },
    { id: 'executioners-axe-blade', name: '형인부월검 카에린', title: '심판은 이미 끝났다',
      grade: 'yongmaek', image: '', imageAlt: '이미지 준비 중', baseIncome: 2150,
      lore: '죄인으로 판명된 자를 벨 때만 진정한 무게를 드러낸다.',
      desc: '거대한 외날 도끼와 검의 중간 형태로, 손잡이에는 이름 모를 수많은 이들의 처형 기록이 새겨져 있다.' },

    /* ---- 금서급 ---- */
    { id: 'lunareaper', name: '혈월도 루나리퍼', title: '피로 떠오르는 달',
      grade: 'geumseo', image: 'img/lunareaper.png', imageAlt: '', baseIncome: 2500,
      lore: '적의 피를 흡수할수록 붉은 달의 형상이 검 뒤에 떠오른다.',
      desc: '달이 완전히 차오르면 검은 강력해지지만, 사용자의 살의도 함께 증폭된다.' },
    { id: 'morgash', name: '심연의 서약, 모르가쉬', title: '그림자를 바친 계약자',
      grade: 'geumseo', image: 'img/morgash.png', imageAlt: '', baseIncome: 2800,
      lore: '심연의 왕과 계약한 금서급 검이다.',
      desc: '사용할수록 강해지지만 사용자의 그림자가 독립된 생명체가 된다. 그림자는 주인의 명령을 따르다가도 언젠가 자신의 의지를 갖기 시작한다.' },
    { id: 'voidfang', name: '허공의 이빨, 보이드팽', title: '공허를 물어뜯는 자',
      grade: 'geumseo', image: 'img/voidfang.png', imageAlt: '', baseIncome: 3100,
      lore: '실체가 없는 마법과 결계를 물어뜯는 단검이다.',
      desc: '검신이 반투명해 일반적인 방어가 불가능하며, 강한 결계를 베어낼수록 검의 윤곽이 잠시 선명해진다.' },
    { id: 'chronosil', name: '시간의 파편, 크로노실', title: '과거를 바치는 칼날',
      grade: 'geumseo', image: 'img/chronosil.png', imageAlt: '', baseIncome: 3400,
      lore: '검날이 닿은 부분의 시간을 느리게 만든다.',
      desc: '단, 사용할수록 사용자의 과거 기억이 하나씩 사라진다. 검신의 금이 늘어날수록 더 오래된 기억이 사라진다.' },
    { id: 'plague-abyss-blade', name: '역병나락검 자하른', title: '닿은 것은 천천히 시든다',
      grade: 'geumseo', image: '', imageAlt: '이미지 준비 중', baseIncome: 3600,
      lore: '베인 상처는 눈에 보이지 않는 속도로 천천히 썩어 들어간다.',
      desc: '검신은 검게 죽은 나무껍질처럼 갈라져 있고, 사용자조차 손잡이를 오래 쥐면 손끝이 저려온다.' },
    { id: 'wailing-spirit-cry', name: '망령곡성검 세르힐', title: '들은 자는 반드시 돌아본다',
      grade: 'geumseo', image: '', imageAlt: '이미지 준비 중', baseIncome: 3800,
      lore: '휘두를 때마다 죽은 자의 비명이 울려 퍼져 적의 정신을 흔든다.',
      desc: '검신에 무수한 실금이 가 있고, 그 틈새로 낮게 흐느끼는 소리가 끊이지 않고 새어 나온다.' },
    { id: 'black-flame-devourer', name: '흑염탄식검 자카론', title: '삼킨 것은 재도 남지 않는다',
      grade: 'geumseo', image: '', imageAlt: '이미지 준비 중', baseIncome: 4000,
      lore: '벤 자리에서 검은 불길이 치솟아 흔적도 없이 태워버린다.',
      desc: '칼날 안쪽에서 검은 불꽃이 꺼지지 않고 흐르며, 사용할수록 검을 쥔 손끝이 서서히 그을려간다.' },

    /* ---- 왕관급 ---- */
    { id: 'crownbreaker', name: '왕관분쇄자, 크라운브레이커', title: '왕을 무릎 꿇린 자',
      grade: 'wangwan', image: 'img/crownbreaker.png', imageAlt: '', baseIncome: 6000,
      lore: '모든 왕과 지배자의 권능을 무너뜨리기 위해 만들어진 왕관급 대검이다.',
      desc: '상대의 지위가 높을수록 검이 강해지며, 왕의 축복이나 통치 권능을 직접 부술 수 있다.' },
    { id: 'judgment-scale-blade', name: '심판권형검 아그라스', title: '죄의 무게만큼 날카로워진다',
      grade: 'wangwan', image: '', imageAlt: '이미지 준비 중', baseIncome: 6800,
      lore: '상대가 저지른 잘못이 클수록 검날이 더 예리하고 무겁게 변한다.',
      desc: '손잡이 양쪽에 작은 저울 장식이 달려 있으며, 무고한 자 앞에서는 무디고 가벼운 그냥 쇳덩이에 불과하다.' },
    { id: 'nightmare-overlord-throne', name: '악몽패왕검 로엔가', title: '모든 악몽의 근원이자 왕',
      grade: 'wangwan', image: '', imageAlt: '이미지 준비 중', baseIncome: 7600,
      lore: '적을 벨 때마다 그가 가장 두려워하는 존재의 형상이 검신에 잠깐 떠오른다.',
      desc: '왕관 모양의 코등이를 가진 거대한 대검으로, 검을 오래 쥔 자는 매일 밤 같은 왕좌의 꿈을 꾸게 된다.' },

    /* ---- 천성급 ---- */
    { id: 'meteor-fall', name: '낙성검 메테오르', title: '부서져 내리는 별',
      grade: 'cheonseong', image: 'img/meteor-fall.png', imageAlt: '', baseIncome: 9500,
      lore: '검을 휘두르면 수십 개의 파편이 유성처럼 날아갔다가 다시 검신으로 돌아온다.',
      desc: '검이 부서진 것이 아니라, 별 하나가 너무 큰 힘을 담지 못해 여러 조각으로 나뉜 것이다.' },
    { id: 'solfall', name: '태양추락, 솔폴', title: '해가 떨어진 날의 검',
      grade: 'cheonseong', image: 'img/solfall.png', imageAlt: '', baseIncome: 11500,
      lore: '태양의 파편으로 만들어진 검이다.',
      desc: '너무 강한 빛을 내뿜기 때문에 사용자는 항상 검집에 봉인해 두어야 한다. 검을 뽑는 순간 주변의 어둠이 모두 사라진다.' },
    { id: 'vesper-dusk', name: '황혼검 베스퍼', title: '해가 죽는 순간의 칼날',
      grade: 'cheonseong', image: 'img/vesper-dusk.png', imageAlt: '', baseIncome: 13500,
      lore: '낮과 밤의 경계에서만 완전한 힘을 발휘한다.',
      desc: '빛과 어둠 마법을 동시에 벨 수 있으며, 검신의 한쪽은 태양빛을, 다른 한쪽은 밤의 색을 반사한다.' },
    { id: 'ashen-oath-ember', name: '잿불서약검 세이가르', title: '재가 되어도 다시 선다',
      grade: 'cheonseong', image: '', imageAlt: '이미지 준비 중', baseIncome: 15000,
      lore: '부러지거나 부서져도 하루가 지나면 잿더미 속에서 스스로 재조립된다.',
      desc: '칼날 전체가 꺼지지 않는 잔불처럼 은은히 빛나며, 파괴될 때마다 오히려 다음 형태가 더 날카로워진다.' },
    { id: 'collapsed-star-void', name: '붕괴항성검 아베론', title: '빛조차 도망치지 못한 별의 최후',
      grade: 'cheonseong', image: '', imageAlt: '이미지 준비 중', baseIncome: 16500,
      lore: '검끝 주위의 아주 작은 공간이 스스로 무너져 주변의 빛을 삼킨다.',
      desc: '검신 중심에 손톱만 한 완전한 어둠이 떠 있으며, 그 안을 들여다본 자는 아무것도 보이지 않았다고 말한다.' },

    /* ---- 원초급 ---- */
    { id: 'erebos', name: '종언검 에레보스', title: '모든 이야기의 마지막 장',
      grade: 'woncho', image: 'img/erebos.png', imageAlt: '', baseIncome: 50000,
      lore: '베인 대상의 마법과 축복을 하나씩 지워낸다.',
      desc: '마지막에는 이름과 존재까지 삼킨다. 가장 강력한 검이지만, 사용자가 검에 지나치게 의존하면 자신의 기억과 이름도 검의 일부가 된다.' },
    { id: 'arcanum', name: '무명의 성검, 아르카눔', title: '이름을 얻지 못한 성검',
      grade: 'woncho', image: 'img/arcanum.png', imageAlt: '', baseIncome: 65000,
      lore: '누구도 이름을 붙일 수 없는 원초급 검이다.',
      desc: '자격을 얻은 사람마다 전혀 다른 모습과 능력을 보여준다. 어떤 이에게는 성검으로, 어떤 이에게는 창이나 활로 나타날 수도 있다.' },
    { id: 'genesis-gate-warden', name: '개벽문직검 크나스', title: '문 너머를 지키는 마지막 눈',
      grade: 'woncho', image: '', imageAlt: '이미지 준비 중', baseIncome: 78000,
      lore: '균열 너머 세계의 존재가 이쪽으로 넘어오려 할 때 검이 스스로 울린다.',
      desc: '검신 전체에 다른 세계의 풍경이 물결치듯 비치며, 이 검을 오래 지닌 자는 가끔 문 너머의 목소리를 듣는다고 한다.' },
    { id: 'primordial-silence-blade', name: '태초적막검 카에스타', title: '세계가 시작되기 전, 이미 여기 있었다',
      grade: 'woncho', image: '', imageAlt: '이미지 준비 중', baseIncome: 92000,
      lore: '이 검이 움직이는 순간에만 세계는 비로소 "이전"과 "이후"로 나뉜다.',
      desc: '아무 장식도 없는 새까만 직검이지만, 이 검을 처음 본 이들은 하나같이 태어나기 전의 기억이 스치는 듯한 기분을 느꼈다고 전한다.' },
  ];

  function nebelacSwordById(id) {
    if (id === PRACTICE_SWORD.id) return PRACTICE_SWORD;
    return NEBELAC_SWORDS.find((s) => s.id === id) || null;
  }
  function gradeIdxOf(sword) {
    if (!sword || !sword.grade) return -1;
    return SWORD_GRADES.findIndex((g) => g.key === sword.grade);
  }
  function gradeOf(sword) {
    const idx = gradeIdxOf(sword);
    return idx >= 0 ? SWORD_GRADES[idx] : null;
  }
  // 등급 우선, 같은 등급 안에서는 기본 효율 오름차순 — 도감/보유목록 정렬 기준.
  function nebelacSwordPower(sword) {
    return gradeIdxOf(sword) * 1e9 + (sword.baseIncome || 0);
  }

  /* ---------------- 강화 (+0 ~ +10, 실패 없음) ---------------- */
  const ENHANCE_LEVELS = [
    { level: 1,  pct: 0.02, fragment: 3,   gold: 5000 },
    { level: 2,  pct: 0.04, fragment: 5,   gold: 10000 },
    { level: 3,  pct: 0.06, fragment: 8,   gold: 18000 },
    { level: 4,  pct: 0.09, fragment: 12,  gold: 30000 },
    { level: 5,  pct: 0.12, fragment: 18,  gold: 50000 },
    { level: 6,  pct: 0.16, fragment: 26,  gold: 80000 },
    { level: 7,  pct: 0.20, fragment: 38,  gold: 125000 },
    { level: 8,  pct: 0.25, fragment: 56,  gold: 190000 },
    { level: 9,  pct: 0.30, fragment: 82,  gold: 280000 },
    { level: 10, pct: 0.36, fragment: 120, gold: 400000 },
  ];
  const ENHANCE_MAX_LEVEL = ENHANCE_LEVELS.length;

  /* ---------------- 공명 (실제 공부시간과 연결) ---------------- */
  const RESONANCE_STAGES = [
    { key: 'silent',    name: '고요',     minMinutes: 0,    fragment: 0,   core: 0,  pct: 0 },
    { key: 'echo',      name: '잔향',     minMinutes: 120,  fragment: 10,  core: 1,  pct: 0.04 },
    { key: 'bond',      name: '결속',     minMinutes: 480,  fragment: 30,  core: 3,  pct: 0.09 },
    { key: 'manifest',  name: '현현',     minMinutes: 1200, fragment: 75,  core: 7,  pct: 0.16 },
    { key: 'complete',  name: '완전공명', minMinutes: 2400, fragment: 180, core: 15, pct: 0.25 },
  ];
  const RESONANCE_MAX_STAGE = RESONANCE_STAGES.length - 1;

  /* ---------------- 일일·주간 임무 ---------------- */
  const DAILY_QUESTS = [
    { id: 'daily-25', minMinutes: 25,  reward: { core: 1 },       label: '25분 집중' },
    { id: 'daily-60', minMinutes: 60,  reward: { fragment: 10 },  label: '60분 집중' },
    { id: 'daily-120', minMinutes: 120, reward: { gold: 5000 },   label: '120분 집중' },
  ];
  const WEEKLY_QUESTS = [
    { id: 'weekly-300', minMinutes: 300, reward: { core: 5, seal: 1 },  label: '주간 300분 집중' },
    { id: 'weekly-600', minMinutes: 600, reward: { core: 10, seal: 1 }, label: '주간 600분 집중' },
    { id: 'weekly-streak5', minDays25: 5, reward: { fragment: 100 },    label: '5일 이상 25분 집중' },
  ];

  /* ---------------- 별자리 인장 확정 소환 ---------------- */
  /* 가격은 등급별 기본 효율(baseIncome)에 맞춰 책정 -- 구간이 열어주는
     최고 효율이 클수록, 그리고 그 효율이 직전 구간보다 얼마나 더 크게
     뛰는지에 비례해 값이 오른다. 특히 천성급(최고 13,500/분) →
     원초급(최고 65,000/분)은 약 5배 차이로 전체 등급 사다리에서 가장 큰
     도약이라, 마지막 구간 가격도 그만큼 가장 크게 뛰도록 잡았다. */
  const SEAL_REDEMPTION_TIERS = [
    { seals: 6,   maxGradeIdx: 2, label: '잔광급~성유급 중 원하는 검' },
    { seals: 14,  maxGradeIdx: 3, label: '용맥급 이하 중 원하는 검' },
    { seals: 30,  maxGradeIdx: 4, label: '금서급 이하 중 원하는 검' },
    { seals: 50,  maxGradeIdx: 6, minGradeIdx: 5, label: '왕관급 또는 천성급 검' },
    { seals: 75,  maxGradeIdx: 6, minGradeIdx: 6, label: '원하는 천성급 검' },
    { seals: 200, maxGradeIdx: 7, minGradeIdx: 7, label: '원하는 원초급 검' },
  ];

  /* ---------------- 여정 지도 — 누적 공부시간으로 지역 해금 ---------------- */
  const JOURNEY_REGIONS = [
    { id: 'frost-library', name: '빙결 도서관', minMinutes: 0, image: 'img/regions/frozen-library.png', imageAlt: '빙결 도서관',
      desc: '서리로 뒤덮인 고대 지식의 전당. 얼어붙은 책장 사이로 낮게 울리는 바람 소리가 들린다.' },
    { id: 'night-alley', name: '밤의 골목', minMinutes: 300, image: 'img/regions/night-alley.png', imageAlt: '밤의 골목',
      desc: '가로등 하나 없는 뒷골목. 그림자들이 소리 없이 움직인다는 소문이 돈다.' },
    { id: 'thunder-plateau', name: '폭뢰 고원', minMinutes: 900, image: 'img/regions/thunderclap-plateau.png', imageAlt: '폭뢰 고원',
      desc: '하늘이 갈라질 때마다 번개가 대지를 두드리는 황량한 고원.' },
    { id: 'crimson-sanctum', name: '붉은 달 성역', minMinutes: 1800, image: 'img/regions/red-moon-sanctum.png', imageAlt: '붉은 달 성역',
      desc: '매달 한 번 달이 핏빛으로 물드는, 오랫동안 봉인되어 온 성소.' },
    { id: 'starsea-port', name: '별바다 항구', minMinutes: 3000, image: 'img/regions/starsea-harbor.png', imageAlt: '별바다 항구',
      desc: '밤하늘이 그대로 바다에 비치는 신비로운 항구 도시.' },
    { id: 'dragonbone-desert', name: '용골 사막', minMinutes: 4800, image: 'img/regions/dragonbone-desert.png', imageAlt: '용골 사막',
      desc: '멸종한 고대 용들의 뼈가 모래 위로 드러난 광활한 사막.' },
    { id: 'life-cathedral', name: '생명의 성당', minMinutes: 7200, image: 'img/regions/cathedral-of-life.png', imageAlt: '생명의 성당',
      desc: '시들지 않는 꽃들로 뒤덮인, 치유의 기운이 감도는 성당.' },
    { id: 'fallen-star-crater', name: '추락성 분화구', minMinutes: 10000, image: 'img/regions/fallen-star-crater.png', imageAlt: '추락성 분화구',
      desc: '하늘에서 떨어진 별의 파편이 남긴 거대한 분화구.' },
    { id: 'mirror-desert', name: '거울 사막', minMinutes: 14000, image: 'img/regions/mirror-desert.png', imageAlt: '거울 사막',
      desc: '걸음마다 다른 자신의 모습이 비치는 기이한 모래벌판.' },
    { id: 'sunken-kingdom', name: '침몰 왕국', minMinutes: 19000, image: 'img/regions/sunken-kingdom.png', imageAlt: '침몰 왕국',
      desc: '바닷속에 가라앉은 채로도 여전히 불빛이 새어 나오는 옛 왕국.' },
    { id: 'border-city', name: '경계 도시', minMinutes: 25000, image: 'img/regions/border-city.png', imageAlt: '경계 도시',
      desc: '균열과 인간 세계의 경계에 세워진, 모든 세력이 뒤섞이는 도시.' },
    { id: 'last-gate', name: '마지막 문', minMinutes: 32000, image: 'img/regions/last-gate.png', imageAlt: '마지막 문',
      desc: '천공의 상처로 이어지는 마지막 관문. 그 너머에서 돌아온 이는 아무도 없다.' },
  ];
  // 지역 해금 자체는 분당 성휘 수입을 올리지 않는다 — 해금 시 받는 1회성
  // 보상만 있다 (스펙에 정확한 수치가 없어 완만한 기본값으로 채움).
  const JOURNEY_REGION_REWARD_CORE = 1;

  /* 강화 단계를 "+N" 뱃지로 표시 — 검 이름 옆 어디서나 재사용. */
  function setEnhanceBadge(el, level) {
    if (level > 0) { el.textContent = `+${level}`; el.hidden = false; }
    else el.hidden = true;
  }

  /* ---------------- 검 이미지 (준비 중 플레이스홀더) ----------------
     image가 비어 있으면 <img>를 완전히 숨기고 고정 크기 플레이스홀더
     박스를 보여준다 — src=''로 두면 브라우저가 깨진 이미지 아이콘을
     그리거나 현재 페이지를 재요청하므로, hidden 토글로만 전환한다. */
  function applySwordArt(imgEl, placeholderEl, sword) {
    if (sword && sword.image) {
      imgEl.src = sword.image;
      imgEl.alt = sword.imageAlt || sword.name;
      imgEl.hidden = false;
      if (placeholderEl) placeholderEl.hidden = true;
    } else {
      imgEl.hidden = true;
      imgEl.removeAttribute('src');
      imgEl.alt = '';
      if (placeholderEl) {
        placeholderEl.hidden = false;
        placeholderEl.textContent = (sword && sword.imageAlt) || '이미지 준비 중';
      }
    }
  }

  /* ---------------- 강화 (+0 ~ +10, 실패 없음) ---------------- */
  function enhanceLevelOf(swordId) { return swordEnhanceLv[swordId] || 0; }
  function enhancePctFor(swordId) {
    const lv = enhanceLevelOf(swordId);
    return lv > 0 ? ENHANCE_LEVELS[lv - 1].pct : 0;
  }
  function enhanceNextStep(swordId) {
    const lv = enhanceLevelOf(swordId);
    return lv < ENHANCE_MAX_LEVEL ? ENHANCE_LEVELS[lv] : null;
  }
  function canEnhance(swordId) {
    const next = enhanceNextStep(swordId);
    return !!next && gold >= next.gold && resonanceFragments >= next.fragment;
  }
  function performEnhance(swordId) {
    const next = enhanceNextStep(swordId);
    if (!next || !canEnhance(swordId)) return false;
    gold -= next.gold;
    resonanceFragments -= next.fragment;
    swordEnhanceLv[swordId] = next.level;
    queueSave();
    return true;
  }

  /* ---------------- 공명 (실제 공부시간과 연결) ---------------- */
  function resonanceStageIndexFor(swordId) { return swordResonanceStage[swordId] || 0; }
  function resonanceMinutesFor(swordId) { return Math.floor(swordResonanceMin[swordId] || 0); }
  function resonancePctFor(swordId) { return RESONANCE_STAGES[resonanceStageIndexFor(swordId)].pct; }
  function resonanceNextStage(swordId) {
    const cur = resonanceStageIndexFor(swordId);
    return cur < RESONANCE_MAX_STAGE ? RESONANCE_STAGES[cur + 1] : null;
  }
  // 시간 조건은 채웠지만 아직 파편·성핵을 지불해 확정 짓지 않은 상태.
  function resonanceTimeReady(swordId) {
    const next = resonanceNextStage(swordId);
    return !!next && resonanceMinutesFor(swordId) >= next.minMinutes;
  }
  function canResonate(swordId) {
    const next = resonanceNextStage(swordId);
    if (!next || !resonanceTimeReady(swordId)) return false;
    return starCores >= next.core && resonanceFragments >= next.fragment;
  }
  function performResonance(swordId) {
    const next = resonanceNextStage(swordId);
    if (!canResonate(swordId)) return false;
    starCores -= next.core;
    resonanceFragments -= next.fragment;
    swordResonanceStage[swordId] = resonanceStageIndexFor(swordId) + 1;
    queueSave();
    return true;
  }
  // 실제 측정된 공부 분(分)을 "그 시간 동안 장착하고 있던 검"에 누적한다 —
  // finalizeSession()에서만 호출되므로 타이머가 실제로 흐른 시간만 쌓인다.
  function addResonanceMinutes(swordId, minutes) {
    if (!minutes || swordId === PRACTICE_SWORD.id) return;
    swordResonanceMin[swordId] = resonanceMinutesFor(swordId) + minutes;
  }

  /* ---------------- 분당 성휘 수입 ---------------- */
  function swordIncomeAt(swordId) {
    const sword = nebelacSwordById(swordId);
    if (!sword) return 0;
    return Math.round(sword.baseIncome * (1 + enhancePctFor(swordId)) * (1 + resonancePctFor(swordId)));
  }
  function currentStudyIncome() {
    return BASE_INCOME_PER_MIN + swordIncomeAt(equippedSwordId);
  }
  function renderStudyHint() {
    const income = currentStudyIncome();
    const boostNote = boostRemainingSeconds > 0
      ? ` <span class="boost-note">⚡ 부스트 중 (남은 ${formatDurationLabel(boostRemainingSeconds)}) — 분당 성휘 2배</span>`
      : '';
    timerHint.innerHTML = `1분마다 ${income.toLocaleString('ko-KR')} 성휘, 1시간이면 ${(income * 60).toLocaleString('ko-KR')} 성휘를 획득해요${boostNote}`;
  }

  /* ---------------- 소환 (천명 게이지 보장) ---------------- */
  function rollGradeIdxPlain() {
    let roll = Math.random() * 100;
    for (let i = 0; i < SWORD_GRADES.length; i++) {
      if (roll < SWORD_GRADES[i].chance) return i;
      roll -= SWORD_GRADES[i].chance;
    }
    return SWORD_GRADES.length - 1;
  }
  // fromIdx 이상의 등급 중, 그 등급들의 원래 확률 비율 그대로 하나를 고른다.
  function rollGradeIdxFrom(fromIdx) {
    const slice = SWORD_GRADES.slice(fromIdx);
    const total = slice.reduce((s, g) => s + g.chance, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < slice.length; i++) {
      if (roll < slice[i].chance) return fromIdx + i;
      roll -= slice[i].chance;
    }
    return SWORD_GRADES.length - 1;
  }
  function drawOneGradeIdx() {
    let forcedFrom = -1;
    for (const rule of PITY_RULES) {
      if ((pityStreak[rule.key] || 0) + 1 >= rule.streak) {
        if (rule.minGradeIdx > forcedFrom) forcedFrom = rule.minGradeIdx;
      }
    }
    const gradeIdx = forcedFrom >= 0 ? rollGradeIdxFrom(forcedFrom) : rollGradeIdxPlain();
    for (const rule of PITY_RULES) {
      pityStreak[rule.key] = gradeIdx >= rule.minGradeIdx ? 0 : (pityStreak[rule.key] || 0) + 1;
    }
    return gradeIdx;
  }
  function rollSwordFromGrade(gradeIdx) {
    const pool = NEBELAC_SWORDS.filter((s) => s.grade === SWORD_GRADES[gradeIdx].key);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function performSummon(count) {
    const cost = count === 10 ? SUMMON_COST_TEN : SUMMON_COST_SINGLE;
    if (gold < cost) {
      showToast(`💸 성휘가 부족해요. ${count}회 소환에 ${cost.toLocaleString('ko-KR')} 성휘가 필요합니다.`);
      return;
    }
    gold -= cost;
    totalSummons += count;

    const results = [];
    let fragmentsGained = 0;
    let newlyDiscovered = 0;
    for (let i = 0; i < count; i++) {
      const gradeIdx = drawOneGradeIdx();
      const sword = rollSwordFromGrade(gradeIdx);
      const isNew = !discoveredSwordIds.includes(sword.id);
      if (isNew) { discoveredSwordIds.push(sword.id); newlyDiscovered++; }
      else fragmentsGained += DUPLICATE_FRAGMENTS_BY_GRADE[gradeIdx];
      results.push({ sword, gradeIdx, isNew });
    }
    resonanceFragments += fragmentsGained;

    queueSave();
    renderGold();
    renderSummonResults(results);
    renderHallPanel();
    renderCodex();
    renderJourneyPanel();

    const best = results.reduce((a, b) => (b.gradeIdx > a.gradeIdx ? b : a));
    const fragText = fragmentsGained > 0 ? ` (✳ 공명 파편 +${fragmentsGained.toLocaleString('ko-KR')})` : '';
    if (newlyDiscovered > 0) {
      showToast(`⚔️ [${SWORD_GRADES[best.gradeIdx].name}] ${best.sword.name} 등 새로운 검 ${newlyDiscovered}자루를 도감에 기록했습니다.${fragText}`);
    } else {
      showToast(`✳ 이미 가진 검이라 공명 파편 ${fragmentsGained.toLocaleString('ko-KR')}개로 바뀌었어요.`);
    }
  }

  function renderSummonResults(results) {
    summonResults.innerHTML = '';
    summonResultsEmpty.style.display = results.length ? 'none' : 'block';
    results.forEach((r, i) => {
      const node = swordResultTpl.content.cloneNode(true);
      const card = node.querySelector('.sword-result');
      card.classList.add(`rar-${r.gradeIdx}`);
      card.style.animationDelay = `${Math.min(i, 20) * 35}ms`;
      node.querySelector('.sword-result-grade').textContent = SWORD_GRADES[r.gradeIdx].name;
      node.querySelector('.sword-result-name').textContent = r.sword.name;
      node.querySelector('.sword-result-hanja').textContent = SWORD_GRADES[r.gradeIdx].hanja;
      const tag = node.querySelector('.sword-result-tag');
      if (r.isNew) tag.textContent = 'NEW';
      else tag.remove();
      summonResults.appendChild(node);
    });
  }

  function equipSword(id) {
    if (id === equippedSwordId || !discoveredSwordIds.includes(id)) return;
    equippedSwordId = id;
    queueSave();
    renderHallPanel();
    renderCodex();
    renderGrowthPanel();
    renderStudyHint();
    renderHeader();
    renderMainPanel();
    const sword = nebelacSwordById(id) || PRACTICE_SWORD;
    showToast(`⚔️ ${sword.name}을(를) 장착했습니다.`);
  }

  /* ---------------- 별자리 인장 확정 소환 ---------------- */
  function eligibleSealSwords(tier) {
    const lo = tier.minGradeIdx ?? 0;
    return NEBELAC_SWORDS.filter((s) => { const g = gradeIdxOf(s); return g >= lo && g <= tier.maxGradeIdx; });
  }
  function redeemSeal(tierIdx, swordId) {
    const tier = SEAL_REDEMPTION_TIERS[tierIdx];
    const sword = nebelacSwordById(swordId);
    if (!tier || !sword || constellationSeals < tier.seals) return null;
    const g = gradeIdxOf(sword);
    const lo = tier.minGradeIdx ?? 0;
    if (g < lo || g > tier.maxGradeIdx) return null;

    constellationSeals -= tier.seals;
    const isNew = !discoveredSwordIds.includes(swordId);
    if (isNew) discoveredSwordIds.push(swordId);
    else resonanceFragments += DUPLICATE_FRAGMENTS_BY_GRADE[g];
    queueSave();
    return { isNew, sword };
  }

  /* ---------------- 도감 (검, 등급 순) ---------------- */
  let selectedCodexId = null;
  function renderCodex() {
    codexGrid.innerHTML = '';
    codexProgress.textContent = `${nebelacDiscoveredCount()} / ${NEBELAC_SWORDS.length}`;

    const sorted = NEBELAC_SWORDS.slice().sort((a, b) => nebelacSwordPower(a) - nebelacSwordPower(b));
    sorted.forEach((s) => {
      const found = discoveredSwordIds.includes(s.id);
      const gradeIdx = gradeIdxOf(s);
      const node = codexCardTpl.content.cloneNode(true);
      const card = node.querySelector('.codex-card');
      card.dataset.swordId = s.id;
      card.classList.add(`rar-${gradeIdx}`);
      if (!found) card.classList.add('locked');
      if (s.id === equippedSwordId) card.classList.add('equipped');

      const art = node.querySelector('.codex-art-img');
      const placeholder = node.querySelector('.codex-art-placeholder');
      applySwordArt(art, placeholder, found ? s : null);

      if (found) {
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.addEventListener('click', () => selectCodexItem(s.id));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCodexItem(s.id); }
        });
      }

      node.querySelector('.codex-grade').textContent = found ? SWORD_GRADES[gradeIdx].name : '???';
      node.querySelector('.codex-name-text').textContent = found ? s.name : '???';
      const enhanceBadgeEl = node.querySelector('.codex-enhance-badge');
      setEnhanceBadge(enhanceBadgeEl, found ? enhanceLevelOf(s.id) : 0);
      codexGrid.appendChild(node);
    });

    if (selectedCodexId !== null && discoveredSwordIds.includes(selectedCodexId)) selectCodexItem(selectedCodexId);
    else closeCodexShowcase();
  }
  function selectCodexItem(id) {
    const s = nebelacSwordById(id);
    if (!s || !discoveredSwordIds.includes(id)) return;
    selectedCodexId = id;
    const gradeIdx = gradeIdxOf(s);
    codexShowcase.hidden = false;
    codexShowcase.className = `codex-showcase rar-${gradeIdx}`;
    applySwordArt(codexShowcaseImg, codexShowcasePlaceholder, s);
    codexShowcaseGrade.textContent = SWORD_GRADES[gradeIdx].name;
    codexShowcaseName.textContent = s.name;
    codexShowcaseTitle.textContent = `《${s.title}》`;
    setEnhanceBadge(codexShowcaseEnhance, enhanceLevelOf(id));
    codexShowcaseResonance.textContent = RESONANCE_STAGES[resonanceStageIndexFor(id)].name;
    codexShowcaseLore.textContent = s.lore;
    codexShowcaseDesc.textContent = s.desc;
    codexShowcaseIncome.textContent = `분당 +${swordIncomeAt(id).toLocaleString('ko-KR')} 성휘`;

    codexGrid.querySelectorAll('.codex-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.swordId === id);
    });
  }
  function closeCodexShowcase() {
    selectedCodexId = null;
    codexShowcase.hidden = true;
    codexGrid.querySelectorAll('.codex-card.selected').forEach((c) => c.classList.remove('selected'));
  }

  /* ---------------- 여정: 일일·주간 임무 ---------------- */
  function weekKeyFor(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
    return toKey(dt);
  }
  function weekDatesFor(weekKey) {
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(addDays(weekKey, i));
    return dates;
  }
  function sumStudyMinutesForWeek(weekKey) {
    return Math.floor(weekDatesFor(weekKey).reduce((s, dk) => s + sumStudySecondsForDate(dk), 0) / 60);
  }
  function daysWithMinStudyInWeek(weekKey, minMinutes) {
    return weekDatesFor(weekKey).filter((dk) => Math.floor(sumStudySecondsForDate(dk) / 60) >= minMinutes).length;
  }
  function applyReward(reward) {
    if (reward.gold) gold += reward.gold;
    if (reward.core) starCores += reward.core;
    if (reward.fragment) resonanceFragments += reward.fragment;
    if (reward.seal) constellationSeals += reward.seal;
  }
  function rewardLabel(reward) {
    const parts = [];
    if (reward.gold) parts.push(`성휘 ${reward.gold.toLocaleString('ko-KR')}`);
    if (reward.core) parts.push(`성핵 ${reward.core}`);
    if (reward.fragment) parts.push(`공명 파편 ${reward.fragment}`);
    if (reward.seal) parts.push(`별자리 인장 ${reward.seal}`);
    return parts.join(' · ');
  }
  function todayStudyMinutes() { return Math.floor(sumStudySecondsForDate(studyDayKey()) / 60); }
  function claimDailyQuest(quest) {
    const dateKey = studyDayKey();
    const already = (claimedDailyQuests[dateKey] || []).includes(quest.id);
    if (already || todayStudyMinutes() < quest.minMinutes) return false;
    claimedDailyQuests[dateKey] = [...(claimedDailyQuests[dateKey] || []), quest.id];
    applyReward(quest.reward);
    queueSave();
    return true;
  }
  function claimWeeklyQuest(quest) {
    const weekKey = weekKeyFor(todayKey());
    const already = (claimedWeeklyQuests[weekKey] || []).includes(quest.id);
    if (already) return false;
    const eligible = quest.minMinutes
      ? sumStudyMinutesForWeek(weekKey) >= quest.minMinutes
      : daysWithMinStudyInWeek(weekKey, 25) >= quest.minDays25;
    if (!eligible) return false;
    claimedWeeklyQuests[weekKey] = [...(claimedWeeklyQuests[weekKey] || []), quest.id];
    applyReward(quest.reward);
    queueSave();
    return true;
  }

  /* ---------------- 여정: 지역 해금 ---------------- */
  function cumulativeStudyMinutes() { return Math.floor(sumStudySecondsAllTime() / 60); }
  function isRegionUnlocked(region) { return cumulativeStudyMinutes() >= region.minMinutes; }
  function claimRegionReward(region) {
    if (!isRegionUnlocked(region) || claimedRegions.includes(region.id)) return false;
    claimedRegions.push(region.id);
    if (region.minMinutes > 0) starCores += JOURNEY_REGION_REWARD_CORE;
    queueSave();
    return true;
  }

  /* ---------------- 성휘 부스트 ----------------
     계정당 딱 한 번, 이 업데이트를 처음 불러오는 "지금 기준" 최근 30일
     공부시간을 그대로 부스트 예산(초)으로 지급한다(applyState 참고).
     버튼으로 반복 발동하는 게 아니라 일회성 지급이며, 그만큼의 실측정
     공부시간 동안 분당 성휘 수입이 2배가 된다.
     이번 측정 시간 중 부스트가 적용되는 초를 소비하고 돌려준다. */
  function consumeBoostSeconds(seconds) {
    const boosted = Math.min(seconds, boostRemainingSeconds);
    boostRemainingSeconds -= boosted;
    return boosted;
  }

  // seconds(실측정 시간)에 대한 보상을 계산한다. preview:true면 부스트
  // 예산을 실제로 소비하지 않고 "지금 끝내면 얼마 받을지"만 미리 보여준다.
  // base = 부스트가 전혀 없다고 가정했을 때의 보상, bonus = 그중 부스트
  // 구간(2배)이 추가로 얹어준 몫 -- 화면 표시는 숫자를 두 배로 뭉개지
  // 않고 "46800(+46800)"처럼 base와 bonus를 그대로 나눠 보여준다.
  function computeSessionReward(seconds, { preview = false } = {}) {
    const minutes = Math.floor(seconds / 60);
    const income = currentStudyIncome();
    const base = minutes * income;
    if (minutes <= 0 || boostRemainingSeconds <= 0) return { base, bonus: 0, total: base };
    const boostedSeconds = preview ? Math.min(seconds, boostRemainingSeconds) : consumeBoostSeconds(seconds);
    const bonus = Math.floor(boostedSeconds / 60) * income;
    return { base, bonus, total: base + bonus };
  }
  function formatRewardLabel(reward) {
    return reward.bonus > 0
      ? `${reward.base.toLocaleString('ko-KR')}(+${reward.bonus.toLocaleString('ko-KR')})`
      : `+${reward.base.toLocaleString('ko-KR')}`;
  }
  // 분당/시간당 성휘처럼 "실제 보상"이 아니라 순수 수치를 보여주는 자리에서,
  // 부스트가 켜져 있으면 같은 base(+bonus) 표기를 그대로 적용한다.
  function formatBoostedAmount(amount) {
    return boostRemainingSeconds > 0
      ? `${amount.toLocaleString('ko-KR')}(+${amount.toLocaleString('ko-KR')})`
      : amount.toLocaleString('ko-KR');
  }

  /* ---------------- 업적 (공부시간 · 검 수집 · 공명 · 여정 완주) ---------------- */
  // 하루 동안(자정 기준 todayKey 날짜별로) 실제 측정된 공부시간이 한 번이라도
  // minutes 이상이었는지 -- studyByDate 전체를 훑어 "가장 몰입했던 하루"가
  // 기준을 넘긴 적 있는지 확인한다.
  function hasEverStudiedMinutesInADay(minutes) {
    return Object.keys(studyByDate).some((dateKey) => Math.floor(sumStudySecondsForDate(dateKey) / 60) >= minutes);
  }

  const ACHIEVEMENTS = [
    { id: 'study-1h', label: '총 1시간 공부 달성', check: () => cumulativeStudyMinutes() >= 60 },
    { id: 'study-5h', label: '총 5시간 공부 달성', check: () => cumulativeStudyMinutes() >= 300 },
    { id: 'study-10h', label: '총 10시간 공부 달성', check: () => cumulativeStudyMinutes() >= 600 },
    { id: 'study-25h', label: '총 25시간 공부 달성', check: () => cumulativeStudyMinutes() >= 1500 },
    { id: 'study-50h', label: '총 50시간 공부 달성', check: () => cumulativeStudyMinutes() >= 3000 },
    { id: 'study-100h', label: '총 100시간 공부 달성', check: () => cumulativeStudyMinutes() >= 6000 },
    { id: 'study-200h', label: '총 200시간 공부 달성', check: () => cumulativeStudyMinutes() >= 12000 },
    { id: 'study-500h', label: '총 500시간 공부 달성', check: () => cumulativeStudyMinutes() >= 30000 },
    { id: 'study-1000h', label: '총 1,000시간 공부 달성', check: () => cumulativeStudyMinutes() >= 60000 },
    { id: 'focus-day-1h', label: '하루 1시간 이상 집중', check: () => hasEverStudiedMinutesInADay(60) },
    { id: 'focus-day-3h', label: '하루 3시간 이상 집중', check: () => hasEverStudiedMinutesInADay(180) },
    { id: 'focus-day-6h', label: '하루 6시간 이상 집중', check: () => hasEverStudiedMinutesInADay(360) },
    { id: 'streak-7', label: '연속 달성 7일', check: () => computeStreak() >= 7 },
    { id: 'streak-30', label: '연속 달성 30일', check: () => computeStreak() >= 30 },
    { id: 'streak-100', label: '연속 달성 100일', check: () => computeStreak() >= 100 },
    { id: 'collect-5', label: '검 5종 수집', check: () => nebelacDiscoveredCount() >= 5 },
    { id: 'collect-15', label: '검 15종 수집', check: () => nebelacDiscoveredCount() >= 15 },
    { id: 'collect-all', label: `검 ${NEBELAC_SWORDS.length}종 전부 수집`, check: () => nebelacDiscoveredCount() >= NEBELAC_SWORDS.length },
    { id: 'resonance-complete', label: '검 1자루 완전공명 달성', check: () => maxResonanceStage() >= RESONANCE_MAX_STAGE },
    { id: 'journey-complete', label: '여정 완주 (모든 지역 해금)', check: () => isRegionUnlocked(JOURNEY_REGIONS[JOURNEY_REGIONS.length - 1]) },
  ];
  function renderAchievementsInto(container) {
    if (!container) return;
    container.innerHTML = '';
    ACHIEVEMENTS.forEach((a) => {
      const done = a.check();
      const li = document.createElement('li');
      li.className = `achievement-item${done ? ' done' : ''}`;
      li.innerHTML = `<span class="achievement-icon" aria-hidden="true">${done ? '✅' : '🔒'}</span><span class="achievement-label">${a.label}</span>`;
      container.appendChild(li);
    });
  }

  /* ---------------- UI: 메인 탭의 검 상태 카드 ---------------- */
  const mainTodayStudy = el('mainTodayStudy');
  const mainSwordGrade = el('mainSwordGrade');
  const mainSwordName = el('mainSwordName');
  const mainSwordImg = el('mainSwordImg');
  const mainSwordPlaceholder = el('mainSwordPlaceholder');
  const mainSwordEnhanceBadge = el('mainSwordEnhanceBadge');
  const mainSwordResonanceBadge = el('mainSwordResonanceBadge');
  const mainSwordIncome = el('mainSwordIncome');

  function renderMainPanel() {
    if (mainTodayStudy) mainTodayStudy.textContent = formatDurationLabel(sumStudySecondsForDate(studyDayKey()));
    const sword = nebelacSwordById(equippedSwordId) || PRACTICE_SWORD;
    const gradeIdx = gradeIdxOf(sword);
    if (mainSwordGrade) {
      mainSwordGrade.textContent = gradeIdx >= 0 ? SWORD_GRADES[gradeIdx].name : '시작 검';
      mainSwordGrade.className = `sword-grade rar-chip rar-${Math.max(gradeIdx, 0)}`;
    }
    if (mainSwordName) mainSwordName.textContent = sword.name;
    if (mainSwordImg) applySwordArt(mainSwordImg, mainSwordPlaceholder, sword);
    if (mainSwordEnhanceBadge) setEnhanceBadge(mainSwordEnhanceBadge, enhanceLevelOf(equippedSwordId));
    if (mainSwordResonanceBadge) {
      const stage = RESONANCE_STAGES[resonanceStageIndexFor(equippedSwordId)];
      mainSwordResonanceBadge.textContent = stage.key === 'silent' ? '' : stage.name;
      mainSwordResonanceBadge.hidden = stage.key === 'silent';
    }
    if (mainSwordIncome) {
      mainSwordIncome.textContent = `분당 +${formatBoostedAmount(currentStudyIncome())} 성휘`;
    }
  }

  /* ---------------- UI: 검의 전당 (소환 + 보유 검 + 천명 게이지) ---------------- */
  function renderHallPanel() {
    const sword = nebelacSwordById(equippedSwordId) || PRACTICE_SWORD;
    const gradeIdx = gradeIdxOf(sword);
    hallEquippedGrade.textContent = gradeIdx >= 0 ? SWORD_GRADES[gradeIdx].name : '시작 검';
    hallEquippedGrade.className = `sword-grade rar-chip rar-${Math.max(gradeIdx, 0)}`;
    hallEquippedName.textContent = sword.name;
    hallEquippedTitle.textContent = `《${sword.title}》`;
    applySwordArt(hallEquippedImg, hallEquippedPlaceholder, sword);
    hallEquippedLore.textContent = sword.lore;
    hallEquippedDesc.textContent = sword.desc;
    hallEquippedIncome.textContent = `분당 +${swordIncomeAt(equippedSwordId).toLocaleString('ko-KR')} 성휘`;
    setEnhanceBadge(hallEquippedEnhanceBadge, enhanceLevelOf(equippedSwordId));
    const stage = RESONANCE_STAGES[resonanceStageIndexFor(equippedSwordId)];
    hallEquippedResonanceBadge.textContent = stage.key === 'silent' ? '' : stage.name;
    hallEquippedResonanceBadge.hidden = stage.key === 'silent';

    summonCostSingle.textContent = `${SUMMON_COST_SINGLE.toLocaleString('ko-KR')} 성휘`;
    summonCostTen.textContent = `${SUMMON_COST_TEN.toLocaleString('ko-KR')} 성휘`;
    summonBtn1.disabled = gold < SUMMON_COST_SINGLE;
    summonBtn10.disabled = gold < SUMMON_COST_TEN;

    renderGradeChanceTable();

    pityList.innerHTML = '';
    PITY_RULES.forEach((rule) => {
      const cur = pityStreak[rule.key] || 0;
      const li = document.createElement('li');
      li.className = 'pity-row';
      li.innerHTML = `<span class="pity-label">${SWORD_GRADES[rule.minGradeIdx].name} 이상</span><span class="pity-value">${cur} / ${rule.streak}</span>`;
      pityList.appendChild(li);
    });

    renderHallOwnedList();

    sealBalance.textContent = `${constellationSeals.toLocaleString('ko-KR')}개`;
    sealRedeemList.innerHTML = '';
    SEAL_REDEMPTION_TIERS.forEach((tier, tierIdx) => {
      const li = document.createElement('li');
      li.className = 'seal-tier-row';
      const canAfford = constellationSeals >= tier.seals;
      li.innerHTML = `
        <div class="seal-tier-info">
          <span class="seal-tier-cost">${tier.seals}개</span>
          <span class="seal-tier-label">${tier.label}</span>
        </div>
        <button type="button" class="chip-btn seal-tier-btn" ${canAfford ? '' : 'disabled'}>선택하기</button>
        <ul class="seal-tier-picker" hidden></ul>`;
      const btn = li.querySelector('.seal-tier-btn');
      const picker = li.querySelector('.seal-tier-picker');
      btn.addEventListener('click', () => {
        const isOpen = !picker.hidden;
        sealRedeemList.querySelectorAll('.seal-tier-picker').forEach((p) => { p.hidden = true; p.innerHTML = ''; });
        if (isOpen) return;
        eligibleSealSwords(tier).forEach((s) => {
          const g = gradeIdxOf(s);
          const item = document.createElement('li');
          item.className = `seal-pick-item rar-${g}`;
          item.innerHTML = `<span class="seal-pick-grade rar-chip rar-${g}">${SWORD_GRADES[g].name}</span><span class="seal-pick-name">${s.name}</span>`;
          item.addEventListener('click', () => {
            const result = redeemSeal(tierIdx, s.id);
            if (!result) return;
            renderHallPanel();
            renderCodex();
            renderGold();
            const msg = result.isNew
              ? `⭐ ${result.sword.name}을(를) 확정 획득했습니다!`
              : `⭐ 이미 가진 검이라 공명 파편으로 바뀌었어요.`;
            showToast(msg);
          });
          picker.appendChild(item);
        });
        picker.hidden = false;
      });
      sealRedeemList.appendChild(li);
    });
  }

  // 등급 행을 누르면 그 등급에 속한 검 목록이 아래로 펼쳐진다 (예전 검 뽑기
  // 탭에 있던 상호작용을 새 등급별 확률 표에 그대로 복원한 것).
  let expandedGradeIdx = null;
  function renderGradeChanceTable() {
    gradeChanceTable.innerHTML = '';
    SWORD_GRADES.forEach((g, i) => {
      const swordsInGrade = NEBELAC_SWORDS.filter((s) => s.grade === g.key);
      const isOpen = expandedGradeIdx === i;

      const group = document.createElement('li');
      group.className = 'rarity-group';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `rarity-row rar-${i}${isOpen ? ' open' : ''}`;
      btn.dataset.grade = String(i);
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.innerHTML = `
        <span class="rarity-name">${g.name}<small>${g.hanja}</small></span>
        <span class="rarity-chance">${g.chance}%</span>
        <span class="rarity-count">${swordsInGrade.length}종</span>
        <span class="rarity-caret">▾</span>`;
      group.appendChild(btn);

      const sub = document.createElement('ul');
      sub.className = `rarity-sword-list${isOpen ? ' show' : ''}`;
      swordsInGrade.forEach((s, j) => {
        const owned = discoveredSwordIds.includes(s.id);
        const item = document.createElement('li');
        item.className = `rarity-sword-item${owned ? '' : ' undiscovered'}`;
        item.style.animationDelay = isOpen ? `${j * 30}ms` : '0ms';
        item.innerHTML = `<span class="rarity-sword-name">${s.name}</span><span class="rarity-sword-hanja">${s.title}</span><span class="rarity-sword-income">분당 +${s.baseIncome.toLocaleString('ko-KR')} 성휘</span>`;
        sub.appendChild(item);
      });
      group.appendChild(sub);

      gradeChanceTable.appendChild(group);
    });
  }
  gradeChanceTable.addEventListener('click', (e) => {
    const btn = e.target.closest('.rarity-row');
    if (!btn) return;
    const i = Number(btn.dataset.grade);
    expandedGradeIdx = expandedGradeIdx === i ? null : i;
    renderGradeChanceTable();
  });

  function renderHallOwnedList() {
    const equippedIncome = swordIncomeAt(equippedSwordId);
    const owned = discoveredSwordIds
      .map((id) => nebelacSwordById(id) || PRACTICE_SWORD)
      .sort((a, b) => nebelacSwordPower(b) - nebelacSwordPower(a));

    hallOwnedCount.textContent = `${nebelacDiscoveredCount()} / ${NEBELAC_SWORDS.length}`;
    hallOwnedEmpty.style.display = owned.length ? 'none' : 'block';
    hallOwnedList.innerHTML = '';
    owned.forEach((s) => {
      const gradeIdx = gradeIdxOf(s);
      const equipped = s.id === equippedSwordId;
      const income = swordIncomeAt(s.id);
      const recommended = !equipped && income > equippedIncome;
      const item = document.createElement('li');
      item.className = `owned-sword-item rar-${Math.max(gradeIdx, 0)}${equipped ? ' equipped' : ''}`;
      item.innerHTML = `
        <span class="owned-sword-grade rar-chip rar-${Math.max(gradeIdx, 0)}">${gradeIdx >= 0 ? SWORD_GRADES[gradeIdx].name : '시작 검'}</span>
        <span class="owned-sword-name">${s.name}${enhanceLevelOf(s.id) > 0 ? ` <small>+${enhanceLevelOf(s.id)}</small>` : ''}</span>
        <span class="owned-sword-income">분당 +${income.toLocaleString('ko-KR')} 성휘</span>
        ${recommended ? '<span class="recommend-badge">추천</span>' : '<span></span>'}
        <button type="button" class="btn-equip" data-id="${s.id}" ${equipped ? 'disabled' : ''}>${equipped ? '장착 중' : '장착하기'}</button>`;
      hallOwnedList.appendChild(item);
    });
  }
  hallOwnedList.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-equip');
    if (!btn) return;
    equipSword(btn.dataset.id);
  });
  summonBtn1.addEventListener('click', () => performSummon(1));
  summonBtn10.addEventListener('click', () => performSummon(10));
  codexShowcaseClose.addEventListener('click', closeCodexShowcase);

  /* ---------------- UI: 성장 (강화 · 공명 · 유물함) ---------------- */
  let growthActiveSub = 'enhance';
  let selectedGrowthSwordId = null;

  function growthEligibleSwordIds() {
    return discoveredSwordIds.filter((id) => id !== PRACTICE_SWORD.id);
  }

  growthSubtabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.exam-tab');
    if (!btn || btn.classList.contains('active')) return;
    growthActiveSub = btn.dataset.sub;
    growthSubtabs.querySelectorAll('.exam-tab').forEach((t) => t.classList.toggle('active', t === btn));
    renderGrowthPanel();
  });

  function renderGrowthPanel() {
    Object.entries(growthPanels).forEach(([key, panel]) => panel.classList.toggle('active', key === growthActiveSub));
    if (growthActiveSub === 'enhance') renderGrowthEnhance();
    else if (growthActiveSub === 'resonance') renderGrowthResonance();
    else renderGrowthRelics();
  }

  // 등급 높은 순으로 정렬한 뒤, 장착 중인 검이 있으면 맨 앞으로 끌어온다 --
  // 강화하려고 들어왔을 때 대개 손보고 싶은 건 지금 쓰고 있는 검이라서.
  function growthEnhanceSortedIds() {
    const ids = growthEligibleSwordIds()
      .slice()
      .sort((a, b) => nebelacSwordPower(nebelacSwordById(b)) - nebelacSwordPower(nebelacSwordById(a)));
    const equippedAt = ids.indexOf(equippedSwordId);
    if (equippedAt > 0) {
      ids.splice(equippedAt, 1);
      ids.unshift(equippedSwordId);
    }
    return ids;
  }

  function renderGrowthEnhance() {
    const ids = growthEnhanceSortedIds();
    if (!ids.length) {
      growthEnhanceDisplay.style.display = 'none';
      growthEnhanceEmpty.style.display = 'block';
      growthEnhanceSelect.innerHTML = '';
      return;
    }
    growthEnhanceEmpty.style.display = 'none';
    growthEnhanceDisplay.style.display = '';
    if (!selectedGrowthSwordId || !ids.includes(selectedGrowthSwordId)) selectedGrowthSwordId = ids[0];

    growthEnhanceSelect.innerHTML = '';
    ids.forEach((id) => {
      const s = nebelacSwordById(id);
      const opt = document.createElement('option');
      opt.value = id;
      const lv = enhanceLevelOf(id);
      opt.textContent = `[${SWORD_GRADES[gradeIdxOf(s)].name}] ${s.name}${lv ? ` +${lv}` : ''}`;
      if (id === selectedGrowthSwordId) opt.selected = true;
      growthEnhanceSelect.appendChild(opt);
    });

    const id = selectedGrowthSwordId;
    const s = nebelacSwordById(id);
    const gradeIdx = gradeIdxOf(s);
    const lv = enhanceLevelOf(id);
    if (lv > 0) {
      growthEnhanceBadgeArt.src = `img/enhance/lv${lv}.png`;
      growthEnhanceBadgeArt.alt = `강화 +${lv} 등급장`;
      growthEnhanceBadgeArt.hidden = false;
    } else {
      growthEnhanceBadgeArt.hidden = true;
      growthEnhanceBadgeArt.removeAttribute('src');
    }
    growthEnhanceGrade.textContent = SWORD_GRADES[gradeIdx].name;
    growthEnhanceGrade.className = `sword-grade rar-chip rar-${gradeIdx}`;
    growthEnhanceName.textContent = s.name;
    growthEnhanceLevel.textContent = `+${lv} / +${ENHANCE_MAX_LEVEL}`;
    growthEnhanceIncome.textContent = `검 효율 분당 +${swordIncomeAt(id).toLocaleString('ko-KR')} 성휘`;

    const next = enhanceNextStep(id);
    if (!next) {
      growthEnhanceNextInfo.textContent = '이미 최대 강화 단계예요.';
      growthEnhanceBtn.disabled = true;
      growthEnhanceBtn.textContent = '강화 완료';
    } else {
      growthEnhanceNextInfo.innerHTML = `+${next.level} 도전 · 공명 파편 ${next.fragment.toLocaleString('ko-KR')} · 성휘 ${next.gold.toLocaleString('ko-KR')} · 효율 누적 +${Math.round(next.pct * 100)}%`;
      growthEnhanceBtn.disabled = !canEnhance(id);
      growthEnhanceBtn.textContent = `강화하기 (+${lv} → +${next.level})`;
    }
  }
  growthEnhanceSelect.addEventListener('change', () => {
    selectedGrowthSwordId = growthEnhanceSelect.value;
    renderGrowthEnhance();
  });
  growthEnhanceBtn.addEventListener('click', () => {
    const id = selectedGrowthSwordId;
    if (!id) return;
    const next = enhanceNextStep(id);
    if (!next) return;
    if (!canEnhance(id)) {
      showToast(`✳ 재료가 부족해요. 공명 파편 ${next.fragment.toLocaleString('ko-KR')} · 성휘 ${next.gold.toLocaleString('ko-KR')}이 필요합니다.`);
      return;
    }
    performEnhance(id);
    renderGrowthEnhance();
    renderHallPanel();
    renderCodex();
    renderStudyHint();
    renderHeader();
    renderMainPanel();
    renderGold();
    showToast(`✨ ${nebelacSwordById(id).name} 강화 성공! +${next.level} 달성`);
  });

  function renderGrowthResonance() {
    const ids = growthEligibleSwordIds();
    if (!ids.length) {
      growthResonanceDisplay.style.display = 'none';
      growthResonanceEmpty.style.display = 'block';
      growthResonanceSelect.innerHTML = '';
      return;
    }
    growthResonanceEmpty.style.display = 'none';
    growthResonanceDisplay.style.display = '';
    if (!selectedGrowthSwordId || !ids.includes(selectedGrowthSwordId)) selectedGrowthSwordId = ids[0];

    growthResonanceSelect.innerHTML = '';
    ids.forEach((id) => {
      const s = nebelacSwordById(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `[${SWORD_GRADES[gradeIdxOf(s)].name}] ${s.name} · ${RESONANCE_STAGES[resonanceStageIndexFor(id)].name}`;
      if (id === selectedGrowthSwordId) opt.selected = true;
      growthResonanceSelect.appendChild(opt);
    });

    const id = selectedGrowthSwordId;
    const s = nebelacSwordById(id);
    const gradeIdx = gradeIdxOf(s);
    growthResonanceGrade.textContent = SWORD_GRADES[gradeIdx].name;
    growthResonanceGrade.className = `sword-grade rar-chip rar-${gradeIdx}`;
    growthResonanceName.textContent = s.name;
    growthResonanceStageName.textContent = RESONANCE_STAGES[resonanceStageIndexFor(id)].name;

    const next = resonanceNextStage(id);
    const minutes = resonanceMinutesFor(id);
    if (!next) {
      growthResonanceProgress.textContent = '완전공명에 도달했어요.';
      growthResonanceNextInfo.textContent = '';
      growthResonanceBtn.disabled = true;
      growthResonanceBtn.textContent = '공명 완료';
    } else {
      growthResonanceProgress.textContent = `이 검과 함께한 공부시간 ${formatDurationLabel(minutes * 60)} / ${formatDurationLabel(next.minMinutes * 60)}`;
      if (!resonanceTimeReady(id)) {
        growthResonanceNextInfo.textContent = `${next.name} 단계까지 공부시간이 더 필요해요.`;
        growthResonanceBtn.disabled = true;
      } else {
        growthResonanceNextInfo.innerHTML = `${next.name} 단계 · 성핵 ${next.core} · 공명 파편 ${next.fragment.toLocaleString('ko-KR')} · 효율 누적 +${Math.round(next.pct * 100)}%`;
        growthResonanceBtn.disabled = !canResonate(id);
      }
      growthResonanceBtn.textContent = `공명하기 (${RESONANCE_STAGES[resonanceStageIndexFor(id)].name} → ${next.name})`;
    }
  }
  growthResonanceSelect.addEventListener('change', () => {
    selectedGrowthSwordId = growthResonanceSelect.value;
    renderGrowthResonance();
  });
  growthResonanceBtn.addEventListener('click', () => {
    const id = selectedGrowthSwordId;
    if (!id) return;
    const next = resonanceNextStage(id);
    if (!next || !resonanceTimeReady(id)) return;
    if (!canResonate(id)) {
      showToast(`✳ 재료가 부족해요. 성핵 ${next.core} · 공명 파편 ${next.fragment.toLocaleString('ko-KR')}이 필요합니다.`);
      return;
    }
    performResonance(id);
    renderGrowthResonance();
    renderHallPanel();
    renderCodex();
    renderStudyHint();
    renderHeader();
    renderMainPanel();
    renderGold();
    showToast(`💫 ${nebelacSwordById(id).name}이(가) ${RESONANCE_STAGES[resonanceStageIndexFor(id)].name} 단계에 도달했습니다.`);
  });

  // 유물함: 이번 개편으로 이전 시대 장비 데이터는 모두 삭제됐다 — 앞으로 이
  // 자리에 쌓일 기록용 콘텐츠를 위한 빈 보관함으로 시작한다.
  function renderGrowthRelics() {
    growthRelicsList.innerHTML = '';
    growthRelicsEmpty.style.display = 'block';
  }

  /* ---------------- UI: 여정 ---------------- */
  /* 지역 캐러셀 -- 현재 보고 있는 지역 하나만 크게 보여주고 화살표로
     이전/다음 지역을 넘긴다. null이면 아직 초기화 전(첫 렌더에서 여정의
     최전선으로 맞춰짐). */
  let journeyViewIndex = null;

  function fillRegionSlide() {
    const r = JOURNEY_REGIONS[journeyViewIndex];
    const unlocked = isRegionUnlocked(r);
    const claimed = claimedRegions.includes(r.id);
    const rewardText = r.minMinutes > 0 ? `성핵 +${JOURNEY_REGION_REWARD_CORE}` : '시작 지역';

    journeyRegionBadge.textContent = `${journeyViewIndex + 1} / ${JOURNEY_REGIONS.length}`;
    applySwordArt(regionImg, regionPlaceholder, unlocked ? r : null);
    regionName.textContent = unlocked ? r.name : '???';
    regionDesc.textContent = unlocked ? r.desc : '아직 발을 들이지 못한 땅. 공부시간을 더 채우면 모습을 드러낸다.';
    regionStatus.textContent = unlocked ? rewardText : `누적 ${formatDurationLabel(r.minMinutes * 60)} 필요`;
    regionClaimBtn.disabled = !unlocked || claimed;
    regionClaimBtn.textContent = claimed ? '수령 완료' : unlocked ? '수령하기' : '잠김';

    regionPrevBtn.disabled = journeyViewIndex === 0;
    regionNextBtn.disabled = journeyViewIndex === JOURNEY_REGIONS.length - 1;
  }

  // direction: 'left'|'right' -- 화살표로 넘길 때만 부드러운 슬라이드
  // 애니메이션을 준다. 수령 등으로 같은 지역을 다시 그릴 때는 애니메이션 없이.
  function renderRegionSlide(direction) {
    if (!direction) { fillRegionSlide(); return; }
    const outClass = direction === 'right' ? 'slide-out-left' : 'slide-out-right';
    const inClass = direction === 'right' ? 'slide-in-right' : 'slide-in-left';
    regionSlide.classList.add(outClass);
    setTimeout(() => {
      fillRegionSlide();
      regionSlide.classList.remove(outClass);
      regionSlide.classList.add(inClass);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => regionSlide.classList.remove(inClass));
      });
    }, 180);
  }

  function goToRegion(delta) {
    if (journeyViewIndex === null) return;
    const next = Math.min(JOURNEY_REGIONS.length - 1, Math.max(0, journeyViewIndex + delta));
    if (next === journeyViewIndex) return;
    journeyViewIndex = next;
    renderRegionSlide(delta > 0 ? 'right' : 'left');
  }
  regionPrevBtn.addEventListener('click', () => goToRegion(-1));
  regionNextBtn.addEventListener('click', () => goToRegion(1));
  regionClaimBtn.addEventListener('click', () => {
    const r = JOURNEY_REGIONS[journeyViewIndex];
    if (!r || !claimRegionReward(r)) return;
    const rewardText = r.minMinutes > 0 ? `성핵 +${JOURNEY_REGION_REWARD_CORE}` : '시작 지역';
    fillRegionSlide();
    journeyCores.textContent = `${starCores.toLocaleString('ko-KR')}개`;
    renderAchievementsInto(journeyAchievementList);
    renderAchievementsInto(recordAchievementList);
    renderGold();
    showToast(`🗺️ ${r.name} 해금! ${rewardText}`);
  });

  // 버튼으로 켜는 게 아니라 계정당 한 번 자동으로 지급되는 일회성
  // 보너스라, 이 카드는 순수 안내용이다 (진행 중 / 이미 다 썼음 두 상태뿐).
  function renderBoostCard() {
    if (boostRemainingSeconds > 0) {
      boostBadge.textContent = '진행 중';
      boostBadge.className = 'badge boost-active';
      boostDesc.textContent = `업데이트 기념 일회성 성휘 부스트가 적용 중이에요. 남은 2배 적용 시간: ${formatDurationLabel(boostRemainingSeconds)} — 이 시간만큼 실제로 공부를 측정하면 그동안 분당 성휘가 2배예요.`;
    } else {
      boostBadge.textContent = '완료';
      boostBadge.className = 'badge';
      boostDesc.textContent = '업데이트 기념 일회성 성휘 부스트를 모두 사용했어요.';
    }
  }

  function renderJourneyPanel() {
    journeyCumulative.textContent = formatDurationLabel(sumStudySecondsAllTime());
    journeyCores.textContent = `${starCores.toLocaleString('ko-KR')}개`;
    journeySeals.textContent = `${constellationSeals.toLocaleString('ko-KR')}개`;
    renderBoostCard();

    const dateKey = studyDayKey();
    const todayMin = todayStudyMinutes();
    journeyDailyList.innerHTML = '';
    DAILY_QUESTS.forEach((q) => {
      const claimed = (claimedDailyQuests[dateKey] || []).includes(q.id);
      const eligible = todayMin >= q.minMinutes;
      const li = document.createElement('li');
      li.className = `quest-row${claimed ? ' claimed' : ''}`;
      li.innerHTML = `
        <div class="quest-info">
          <span class="quest-label">${q.label}</span>
          <span class="quest-reward">${rewardLabel(q.reward)}</span>
        </div>
        <button type="button" class="chip-btn quest-claim-btn" ${claimed || !eligible ? 'disabled' : ''}>${claimed ? '완료' : '받기'}</button>`;
      li.querySelector('.quest-claim-btn').addEventListener('click', () => {
        if (!claimDailyQuest(q)) return;
        renderJourneyPanel();
        renderGold();
        showToast(`🎯 ${q.label} 보상 수령! ${rewardLabel(q.reward)}`);
      });
      journeyDailyList.appendChild(li);
    });

    const weekKey = weekKeyFor(todayKey());
    journeyWeeklyList.innerHTML = '';
    WEEKLY_QUESTS.forEach((q) => {
      const claimed = (claimedWeeklyQuests[weekKey] || []).includes(q.id);
      const eligible = q.minMinutes ? sumStudyMinutesForWeek(weekKey) >= q.minMinutes : daysWithMinStudyInWeek(weekKey, 25) >= q.minDays25;
      const li = document.createElement('li');
      li.className = `quest-row${claimed ? ' claimed' : ''}`;
      li.innerHTML = `
        <div class="quest-info">
          <span class="quest-label">${q.label}</span>
          <span class="quest-reward">${rewardLabel(q.reward)}</span>
        </div>
        <button type="button" class="chip-btn quest-claim-btn" ${claimed || !eligible ? 'disabled' : ''}>${claimed ? '완료' : '받기'}</button>`;
      li.querySelector('.quest-claim-btn').addEventListener('click', () => {
        if (!claimWeeklyQuest(q)) return;
        renderJourneyPanel();
        renderGold();
        showToast(`🎯 ${q.label} 보상 수령! ${rewardLabel(q.reward)}`);
      });
      journeyWeeklyList.appendChild(li);
    });

    // 처음 열 때는 아직 도달하지 못한 다음 지역(=여정의 최전선)을 보여준다.
    if (journeyViewIndex === null) {
      const nextLockedIdx = JOURNEY_REGIONS.findIndex((r) => !isRegionUnlocked(r));
      journeyViewIndex = nextLockedIdx === -1 ? JOURNEY_REGIONS.length - 1 : nextLockedIdx;
    }
    renderRegionSlide();

    renderAchievementsInto(journeyAchievementList);
    renderAchievementsInto(recordAchievementList);
  }

  /* ---------------- Quotes ---------------- */
  const QUOTES = [
    '최선의 결과가 아닌 최선의 노력을',
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
        if (t.done) renderTodos();
      });

      delBtn.addEventListener('click', () => {
        todosByDate[viewingDateKey] = getTodosFor(viewingDateKey).filter((x) => x.id !== t.id);
        persistTodos();
        renderTodos();
        renderSummary();
        renderHeader();
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

    const examDiff = daysBetween(todayK, EXAM_TARGET_DATE);
    examDdayEl.textContent = examDiff === 0 ? 'D-DAY' : examDiff > 0 ? `D-${examDiff}` : `D+${Math.abs(examDiff)}`;

    const withDiff = schedules.map((s) => ({ ...s, diff: daysBetween(todayK, s.date) }));
    upcomingCount.textContent = withDiff.filter((s) => s.diff >= 0).length;

    const qIndex = new Date().getDate() % QUOTES.length;
    motivationQuote.textContent = QUOTES[qIndex];

    // 총 분당 성휘 = 기본 600 + 장착 검 효율. 탭마다 같은 값을 보여줄 수
    // 있도록 currentStudyIncome() 하나를 여기서도 그대로 재사용한다.
    // 부스트가 켜져 있으면 46,800(+46,800)처럼 base(+bonus) 표기로 보여준다.
    const swordPart = swordIncomeAt(equippedSwordId);
    const total = currentStudyIncome();
    incomePerMinute.textContent = formatBoostedAmount(total);
    incomePerMinuteLabel.textContent = boostRemainingSeconds > 0
      ? `분당 성휘 (기본 ${BASE_INCOME_PER_MIN.toLocaleString('ko-KR')} + 검 효율 ${swordPart.toLocaleString('ko-KR')}) · ⚡ 부스트 중 (남은 ${formatDurationLabel(boostRemainingSeconds)})`
      : `분당 성휘 (기본 ${BASE_INCOME_PER_MIN.toLocaleString('ko-KR')} + 검 효율 ${swordPart.toLocaleString('ko-KR')})`;
    incomePerHour.textContent = formatBoostedAmount(total * 60);

    renderMainPanel();
  }

  /* ---------------- Exam checklist ---------------- */
  function renderExamSubjectTabs() {
    examSubjectTabsEl.innerHTML = '';

    const allTab = document.createElement('button');
    allTab.type = 'button';
    allTab.className = 'exam-tab' + (activeExamSubjectId === null ? ' active' : '');
    allTab.textContent = '전체';
    allTab.addEventListener('click', () => {
      activeExamSubjectId = null;
      renderExamSubjectTabs();
      renderExamChecklist();
    });
    examSubjectTabsEl.appendChild(allTab);

    examSubjects.forEach((s) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'exam-tab' + (activeExamSubjectId === s.id ? ' active' : '');

      const label = document.createElement('span');
      label.textContent = s.name;
      tab.appendChild(label);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'exam-tab-del';
      delBtn.title = '탭 삭제';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        examSubjects = examSubjects.filter((x) => x.id !== s.id);
        examChecklist = examChecklist.filter((x) => x.subjectId !== s.id);
        if (activeExamSubjectId === s.id) activeExamSubjectId = null;
        queueSave();
        renderExamSubjectTabs();
        renderExamChecklist();
      });
      tab.appendChild(delBtn);

      tab.addEventListener('click', () => {
        activeExamSubjectId = s.id;
        renderExamSubjectTabs();
        renderExamChecklist();
      });

      examSubjectTabsEl.appendChild(tab);
    });
  }

  function renderExamChecklist() {
    const items = activeExamSubjectId === null
      ? examChecklist
      : examChecklist.filter((t) => t.subjectId === activeExamSubjectId);

    examChecklistList.innerHTML = '';
    examChecklistEmpty.style.display = items.length ? 'none' : 'block';
    examChecklistBadge.textContent = `${items.length}개`;

    items.forEach((t) => {
      const node = examChecklistItemTpl.content.cloneNode(true);
      const li = node.querySelector('.todo-item');
      const checkBtn = node.querySelector('.check-btn');
      const textEl = node.querySelector('.todo-text');
      const delBtn = node.querySelector('.delete-btn');

      textEl.textContent = t.text;
      if (t.done) {
        li.classList.add('done');
        checkBtn.classList.add('done');
        checkBtn.textContent = '✓';
      }

      checkBtn.addEventListener('click', () => {
        t.done = !t.done;
        queueSave();
        renderExamChecklist();
      });

      delBtn.addEventListener('click', () => {
        examChecklist = examChecklist.filter((x) => x.id !== t.id);
        queueSave();
        renderExamChecklist();
      });

      li.dataset.id = t.id;
      examChecklistList.appendChild(node);
    });
  }

  examSubjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = examSubjectTextInput.value.trim();
    if (!name) return;
    const subject = { id: crypto.randomUUID(), name };
    examSubjects.push(subject);
    activeExamSubjectId = subject.id;
    queueSave();
    examSubjectForm.reset();
    renderExamSubjectTabs();
    renderExamChecklist();
  });

  examChecklistForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = examChecklistTextInput.value.trim();
    if (!text) return;
    examChecklist.push({ id: crypto.randomUUID(), text, done: false, subjectId: activeExamSubjectId });
    queueSave();
    examChecklistForm.reset();
    renderExamChecklist();
  });

  /* ---------------- 행복 (칭찬 & 감사 일기) ----------------
     Resets daily like the todo list (todayKey(), not the 5am-shifted
     studyDayKey()) since this is a reflection journal, not a study-time
     metric. The tier ladder is purely a function of today's entry count,
     so it never needs migrating when entries are added or removed. */
  const HAPPINESS_TIERS = [
    { min: 0,  name: '고요한 하루' },
    { min: 1,  name: '소소한 행복' },
    { min: 5,  name: '몽글몽글한 행복' },
    { min: 10, name: '넘치는 행복' },
    { min: 15, name: '반짝이는 행복' },
    { min: 20, name: '행복 만렙' },
  ];
  const HAPPINESS_MAX_PER_DAY = 20;
  function happinessTierIndex(count) {
    let idx = 0;
    for (let i = 0; i < HAPPINESS_TIERS.length; i++) {
      if (count >= HAPPINESS_TIERS[i].min) idx = i;
    }
    return idx;
  }
  function getHappinessFor(dateKey) {
    return happinessByDate[dateKey] || [];
  }

  function renderHappiness() {
    const todayK = todayKey();
    const items = getHappinessFor(todayK);
    const count = items.length;
    const tierIdx = happinessTierIndex(count);
    const tier = HAPPINESS_TIERS[tierIdx];
    const nextTier = HAPPINESS_TIERS[tierIdx + 1];

    const atCap = count >= HAPPINESS_MAX_PER_DAY;

    happinessIndexEl.textContent = count;
    happinessTierNameEl.textContent = tier.name;
    happinessTierHintEl.textContent = atCap
      ? '오늘의 기록을 다 채웠어요! 내일 또 적어주세요 💛'
      : nextTier
        ? `${nextTier.min - count}개 더 적으면 "${nextTier.name}"이 돼요`
        : (count === 0 ? '칭찬과 감사를 적을수록 행복지수가 올라가요' : '오늘 행복지수가 최고조예요! 🎉');
    happinessHeroCard.className = `card happiness-hero-card happiness-tier-${tierIdx}`;

    happinessBadge.textContent = `${count} / ${HAPPINESS_MAX_PER_DAY}`;
    happinessTextInput.disabled = atCap;
    happinessTextInput.placeholder = atCap
      ? '오늘은 다 채우셨어요! 내일 다시 적어주세요'
      : '오늘 나에게 칭찬할 점, 감사한 점을 적어보세요';
    happinessEmpty.style.display = count ? 'none' : 'block';
    happinessList.innerHTML = '';
    items.forEach((item) => {
      const node = happinessItemTpl.content.cloneNode(true);
      node.querySelector('.todo-text').textContent = item.text;
      happinessList.appendChild(node);
    });
  }

  // Confetti-ish burst scaled to the tier just reached — pure CSS/JS,
  // matching the codebase's no-dependency approach (see the 강화 burst
  // effect above for the same one-shot-animation pattern at smaller scale).
  const HAPPINESS_EFFECT_BY_TIER = [
    { count: 0 },
    { count: 5,  emojis: ['✨'] },
    { count: 8,  emojis: ['✨', '💛'] },
    { count: 12, emojis: ['✨', '💛', '🌟'] },
    { count: 16, emojis: ['✨', '💛', '🌟', '🎉'] },
    { count: 22, emojis: ['✨', '💛', '🌟', '🎉', '💖'] },
  ];
  function spawnHappinessEffect(tierIdx) {
    const cfg = HAPPINESS_EFFECT_BY_TIER[Math.min(tierIdx, HAPPINESS_EFFECT_BY_TIER.length - 1)];
    for (let i = 0; i < cfg.count; i++) {
      const span = document.createElement('span');
      span.className = 'happiness-particle';
      span.textContent = cfg.emojis[Math.floor(Math.random() * cfg.emojis.length)];
      const angle = (Math.random() * 2 - 1) * 70; // degrees off straight-up
      const distance = 55 + Math.random() * 70;
      const rad = (angle * Math.PI) / 180;
      span.style.setProperty('--dx', `${Math.sin(rad) * distance}px`);
      span.style.setProperty('--dy', `${-Math.abs(Math.cos(rad)) * distance - 30}px`);
      span.style.animationDelay = `${Math.random() * 0.2}s`;
      span.style.fontSize = `${1 + Math.random() * 0.6}rem`;
      happinessEffectLayer.appendChild(span);
      span.addEventListener('animationend', () => span.remove());
    }
  }

  happinessForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = happinessTextInput.value.trim();
    if (!text) return;
    const todayK = todayKey();
    const list = getHappinessFor(todayK);
    if (list.length >= HAPPINESS_MAX_PER_DAY) return;
    list.push({ id: crypto.randomUUID(), text, createdAt: Date.now() });
    happinessByDate[todayK] = list;

    // 행복 기록은 성휘 등 경제 보상을 주지 않는다 — 정원 배경/꽃/별빛 같은
    // 시각 효과만 행복지수에 따라 바뀐다 (renderHappiness/spawnHappinessEffect).
    queueSave();
    happinessForm.reset();
    renderHappiness();
    spawnHappinessEffect(happinessTierIndex(list.length));
    showToast('💛 기록 완료!');
  });

  /* ---------------- Toast ---------------- */
  let toastTimeout = null;
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  /* ---------------- 성휘 / 성핵 / 별자리 인장 (상단 바) ---------------- */
  function renderGold() {
    goldAmountEl.textContent = gold.toLocaleString('ko-KR');
    topCoreAmountEl.textContent = starCores.toLocaleString('ko-KR');
    topSealAmountEl.textContent = constellationSeals.toLocaleString('ko-KR');
  }

  function addGold(amount) {
    gold += amount;
    queueSave();
    renderGold();
  }

  /* ---------------- Tabs ---------------- */
  function switchTab(name) {
    tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
    Object.entries(tabPanels).forEach(([key, panel]) => panel.classList.toggle('active', key === name));
    if (name === 'ranking') renderRanking(currentRankCategory);
    if (name === 'hall') renderHallPanel();
    if (name === 'growth') renderGrowthPanel();
    if (name === 'codex') renderCodex();
    if (name === 'journey') renderJourneyPanel();
    if (name === 'record') renderAchievementsInto(recordAchievementList);
    if (name === 'profile') renderProfile();
    if (name === 'main') renderMainPanel();
  }
  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ---------------- Ranking ---------------- */
  const RANK_CATEGORIES = {
    study_today: { column: 'study_today', label: (v) => formatDurationLabel(v || 0) },
    study_week: { column: 'study_week', label: (v) => formatDurationLabel(v || 0) },
    study_month: { column: 'study_month', label: (v) => formatDurationLabel(v || 0) },
    study_total: { column: 'study_total', label: (v) => formatDurationLabel(v || 0) },
    sword_collection: { column: 'sword_collection', label: (v) => `${v || 0} / ${NEBELAC_SWORDS.length}` },
    max_resonance_stage: { column: 'max_resonance_stage', label: (v) => RESONANCE_STAGES[v || 0].name },
  };
  const RANK_LABELS = {
    study_today: '☀️ 오늘 공부', study_week: '📅 최근 7일', study_month: '🗓️ 최근 30일',
    study_total: '⏳ 총 공부시간', sword_collection: '📖 도감 수집률', max_resonance_stage: '💫 최고 공명',
  };
  let currentRankCategory = 'study_today';
  // Flips false the first time a new-column query errors outright (the
  // column doesn't exist in the DB yet -- needs a one-time SQL migration:
  // alter table leaderboard add column if not exists study_total bigint not null default 0;
  // alter table leaderboard add column if not exists sword_collection int not null default 0;
  // alter table leaderboard add column if not exists max_resonance_stage int not null default 0;
  // Remembering the failure avoids re-issuing a doomed request on every
  // render and lets the empty state explain *why* instead of just looking
  // broken.
  let newRankColumnsAvailable = true;
  const NEW_RANK_COLUMNS = ['study_total', 'sword_collection', 'max_resonance_stage'];

  // hyojanom asked to see themself on the 랭킹 tab from their own screen
  // while staying invisible to everyone else viewing the same shared rows.
  // Purely a display-time filter applied after the same query everyone
  // else runs -- their row is still fetched, just dropped before render
  // for any viewer who isn't them.
  const GHOST_RANK_USERNAME = 'hyojanom';
  function applyGhostRankFilter(rows) {
    if (currentUsername === GHOST_RANK_USERNAME) return rows;
    return rows.filter((r) => r.username !== GHOST_RANK_USERNAME);
  }

  async function renderRanking(category) {
    currentRankCategory = category;
    rankCategoryButtons.forEach((b) => b.classList.toggle('active', b.dataset.cat === category));
    const cfg = RANK_CATEGORIES[category];
    const isNewColumn = NEW_RANK_COLUMNS.includes(category);

    let rows = [];
    let newColumnUnavailable = false;

    if (isNewColumn && !newRankColumnsAvailable) {
      // Already confirmed missing this session -- don't re-issue a request
      // that can only fail the same way again.
      newColumnUnavailable = true;
    } else {
      // Named columns, not '*' -- keeps updated_at and anything added later out
      // of a query that already runs often and carries an avatar per row.
      const fullColumns = 'user_id, username, nickname, avatar, study_today, study_week, study_month, study_total, sword_collection, max_resonance_stage';
      const legacyColumns = 'user_id, username, nickname, avatar, study_today, study_week, study_month';
      let query = sb.from('leaderboard').select(fullColumns).order(cfg.column, { ascending: false });
      let { data, error } = await query.limit(200);

      if (error && isNewColumn) {
        // The column itself doesn't exist yet -- a fallback query would
        // still try to order by it and fail identically, so there's no
        // point retrying.
        newRankColumnsAvailable = false;
        newColumnUnavailable = true;
      } else if (error) {
        // A new column errors the whole query (not just that field), which
        // would otherwise blank out every ranking category, not just this
        // one. Fall back to the older column list rather than showing nothing.
        let fallbackQuery = sb.from('leaderboard').select(legacyColumns).order(cfg.column, { ascending: false });
        ({ data, error } = await fallbackQuery.limit(200));
      }

      rows = error ? [] : (data || []);
    }

    rows = applyGhostRankFilter(rows);
    rankList.innerHTML = '';
    rankEmpty.style.display = rows.length ? 'none' : 'block';
    rankEmpty.textContent = newColumnUnavailable
      ? '이 랭킹은 아직 준비 중이에요. (서버 설정이 끝나면 자동으로 표시돼요)'
      : '아직 랭킹 데이터가 없어요.';

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

  // 완전공명에 도달한 검 중 프로필에 대표로 걸 수 있는 검 id[]를 반환.
  function eligibleEpithetSwordIds() {
    return discoveredSwordIds.filter((id) => id !== PRACTICE_SWORD.id && resonanceStageIndexFor(id) >= RESONANCE_MAX_STAGE);
  }

  async function renderProfile() {
    renderAvatar();
    nicknameInput.value = nickname;

    const curSword = nebelacSwordById(equippedSwordId) || PRACTICE_SWORD;
    const gradeIdx = gradeIdxOf(curSword);
    profileSword.textContent = gradeIdx >= 0 ? `[${SWORD_GRADES[gradeIdx].name}] ${curSword.name}` : curSword.name;
    profileSword.className = `profile-stat-value cultivation-name rar-${Math.max(gradeIdx, 0)}`;

    const epithetIds = eligibleEpithetSwordIds();
    profileEpithetSelect.innerHTML = '';
    if (!epithetIds.length) {
      profileEpithetSelect.hidden = true;
      profileEpithetValue.hidden = false;
      profileEpithetValue.textContent = '완전공명에 도달한 검이 없어요';
    } else {
      profileEpithetSelect.hidden = false;
      profileEpithetValue.hidden = true;
      if (!activeEpithetSwordId || !epithetIds.includes(activeEpithetSwordId)) {
        activeEpithetSwordId = epithetIds[epithetIds.length - 1];
        queueSave();
      }
      epithetIds.forEach((id) => {
        const s = nebelacSwordById(id);
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${s.name} — 《${s.title}》`;
        if (id === activeEpithetSwordId) opt.selected = true;
        profileEpithetSelect.appendChild(opt);
      });
    }

    profileGold.textContent = `${gold.toLocaleString('ko-KR')} 성휘`;
    profileGold.className = 'profile-stat-value stat-shine';
    profileCores.textContent = `${starCores.toLocaleString('ko-KR')}개`;
    profileCores.className = 'profile-stat-value stat-shine';
    profileSeals.textContent = `${constellationSeals.toLocaleString('ko-KR')}개`;
    profileSeals.className = 'profile-stat-value stat-shine';

    profileTodayStudy.textContent = formatDurationLabel(sumStudySecondsForDate(studyDayKey()));
    profileTodayStudy.className = 'profile-stat-value stat-shine';

    profileWeekStudy.textContent = formatDurationLabel(sumStudySecondsRolling(7));
    profileWeekStudy.className = 'profile-stat-value stat-shine';

    profileTotalStudy.textContent = formatDurationLabel(sumStudySecondsAllTime());
    profileTotalStudy.className = 'profile-stat-value stat-shine';

    profileCollection.textContent = `${nebelacDiscoveredCount()} / ${NEBELAC_SWORDS.length}`;
    profileCollection.className = 'profile-stat-value stat-shine';

    profileMaxResonance.textContent = RESONANCE_STAGES[maxResonanceStage()].name;
    profileMaxResonance.className = 'profile-stat-value stat-shine';

    profileStreak.textContent = `${computeStreak()}일`;
    profileStreak.className = 'profile-stat-value stat-shine';

    profileRankList.innerHTML = '';
    const entries = Object.entries(RANK_CATEGORIES);
    // username rides along on every category so applyGhostRankFilter() can
    // drop hyojanom's row the same way renderRanking() does. Skip new
    // columns once renderRanking() has already found them missing this
    // session -- same doomed-query reasoning as there.
    const results = await Promise.all(entries.map(([key, cfg]) => (
      NEW_RANK_COLUMNS.includes(key) && !newRankColumnsAvailable
        ? Promise.resolve({ data: [], error: null })
        : sb.from('leaderboard').select('user_id, username').order(cfg.column, { ascending: false }).limit(200)
    )));
    entries.forEach(([key], i) => {
      const { data, error } = results[i];
      if (NEW_RANK_COLUMNS.includes(key) && error) newRankColumnsAvailable = false;
      const rows = applyGhostRankFilter(error ? [] : (data || []));
      const idx = rows.findIndex((r) => r.user_id === currentUserId);
      const li = document.createElement('li');
      li.className = 'profile-rank-row';
      const label = RANK_LABELS[key] || key;
      li.innerHTML = `<span class="profile-rank-label">${label}</span><span class="profile-rank-place">${idx >= 0 ? `${idx + 1}위` : '순위 없음'}</span>`;
      profileRankList.appendChild(li);
    });
  }

  profileEpithetSelect.addEventListener('change', () => {
    activeEpithetSwordId = profileEpithetSelect.value || null;
    queueSave();
  });

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
     answer for 3 more hours (6 hours total unattended) and the whole
     measurement is voided, so a timer left running unattended banks
     nothing.

     Both deadlines are derived from startTs and a confirmed counter rather
     than from timers, so closing the tab or reloading cannot dodge a
     check-in: the state is recomputed from the clock on every tick and on
     restore. */
  const CHECKIN_EVERY_MS = 3 * 60 * 60 * 1000;
  const CHECKIN_GRACE_MS = 3 * 60 * 60 * 1000;

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
    const graceHours = Math.round(CHECKIN_GRACE_MS / 3600000);
    showToast(`🚫 ${graceHours}시간 동안 응답이 없어 ${subj ? subj.name : '이번'} 측정이 무효 처리됐어요.`);
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
    const reward = computeSessionReward(seconds, { preview: true });
    adjustReward.innerHTML = reward.total > 0
      ? `이 시간으로 기록하면 ${formatRewardLabel(reward)} 성휘를 받아요`
      : '1분을 채우면 성휘를 받을 수 있어요.';
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

  // 실수로 "측정 종료"를 눌렀을 때를 위한 취소 버튼 -- endTs를 비워
  // stopTimer() 이전 상태로 되돌리고 타이머를 다시 흐르게 한다.
  adjustCancelBtn.addEventListener('click', () => {
    if (!activeSession || !activeSession.endTs) return;
    activeSession.endTs = null;
    queueSave();
    adjustGate.classList.add('hidden');
    startTicking();
    renderTimerUI();
    showToast('▶ 측정을 이어서 진행해요.');
  });

  function finalizeSession(seconds) {
    if (!activeSession) return;
    const subjectId = activeSession.subjectId;
    const subj = subjects.find((s) => s.id === subjectId);

    addStudySeconds(studyDayKey(), subjectId, seconds);
    const minutes = Math.floor(seconds / 60);
    const reward = computeSessionReward(seconds); // 부스트 예산을 실제로 소비함
    // 실제로 측정된(=타이머가 흐른) 시간만 공명에도 반영한다.
    addResonanceMinutes(equippedSwordId, minutes);

    activeSession = null;
    queueSave();

    if (reward.total > 0) {
      addGold(reward.total);
      showToast(`⏱️ ${subj ? subj.name : '공부'} ${formatDurationLabel(seconds)} 기록! ${formatRewardLabel(reward)} 성휘 획득`);
    } else {
      showToast('⏱️ 측정 종료! 1분을 채우면 성휘를 받을 수 있어요.');
    }

    renderSubjects();
    renderTimerUI();
    renderTodayTotal();
    renderHeader();
    renderMainPanel();
    if (tabPanels.growth.classList.contains('active')) renderGrowthPanel();
    if (tabPanels.journey.classList.contains('active')) renderJourneyPanel();
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
    renderExamSubjectTabs();
    renderExamChecklist();
    renderHappiness();

    renderGold();
    renderSubjects();
    renderTimerUI();
    renderStudyHint();
    renderTodayTotal();
    resumeSession();
    renderMainPanel();
    renderHallPanel();
    renderSummonResults([]);
    renderGrowthPanel();
    renderCodex();
    renderJourneyPanel();
    renderAchievementsInto(recordAchievementList);

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
