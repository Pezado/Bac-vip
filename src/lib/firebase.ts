import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, get, push, update } from 'firebase/database';
import firebaseConfig from '../../firebase-applet-config.json';
import { Result } from '../types';

// Initialize Firebase with Realtime Database config
const app = initializeApp(firebaseConfig);
export const rtdb = getDatabase(app);

// Keep a dummy db export so any legacy/import references do not break
export const db = rtdb; 

export const ADMIN_PHONE = "942607599";

export interface AppUser {
  username: string;
  phone: string;
  status: 'active' | 'inactive' | 'desactivated' | 'expired' | 'pendente';
  isVip: boolean;
  validity: string;
  creationDate: string;
  localHistory: any[];
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errMsg = error instanceof Error ? error.message : String(error);
  const errInfo = {
    error: errMsg,
    operationType,
    path
  };
  console.error('RTDB Operation Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Compatibility mappings
export const handleDatabaseError = handleFirestoreError;

/**
 * Registers a new user or logs in an existing one using Firebase Realtime Database
 */
export const registerOrLogin = async (username: string, phone: string): Promise<AppUser> => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone.length !== 9) {
    throw new Error("O número de telefone deve ter exatamente 9 dígitos.");
  }
  
  const path = `BAC-BOT/users/${normalizedPhone}`;
  try {
    const dbRef = ref(rtdb, path);
    
    // Fetch all users to do duplicate name/phone collision checks
    const usersRef = ref(rtdb, 'BAC-BOT/users');
    const usersSnapshot = await get(usersRef);
    const allUsers = usersSnapshot.exists() ? usersSnapshot.val() : {};

    const targetUserLower = username.trim().toLowerCase();

    // Check if username is already taken by anyone else (different phone number) in the database
    const nameIsTaken = Object.values(allUsers).some((u: any) => {
      const uPhone = (u?.phone || "").replace(/\D/g, '');
      const name = (u?.username || u?.nome || "").trim().toLowerCase();
      return name === targetUserLower && uPhone !== normalizedPhone;
    });

    if (nameIsTaken) {
      throw new Error("Este nome de usuário já está sendo usado por outra conta. Use outro nome ou outro número.");
    }

    // Since every form submit is "nova inscrição / cadastro" and treated as brand new,
    // we always write/overwrite status: 'pendente' and isVip: false in the DB.
    // This blocks carry-over of old VIP status and resets deleted/wiped databases correctly.
    const expirationDate = new Date();
    expirationDate.setMonth(expirationDate.getMonth() + 1);

    const newUser: AppUser = {
      username: username || "Usuário",
      phone: normalizedPhone,
      status: 'pendente', // Always starts as pending approval
      isVip: false,       // Always starts as VIP false
      validity: expirationDate.toISOString(),
      creationDate: new Date().toISOString(),
      localHistory: []
    };

    await set(dbRef, {
      acertos: 0,
      creationDate: newUser.creationDate,
      dataExpiracao: newUser.validity,
      isVip: false,
      vip: false,
      lastActive: new Date().toISOString(),
      perdas: 0,
      phone: newUser.phone,
      sessionId: "",
      status: 'pendente',
      taxaAcerto: 0,
      username: newUser.username,
      validity: newUser.validity
    });

    localStorage.setItem('cached_app_user', JSON.stringify(newUser));
    return newUser;
  } catch (error: any) {
    // Re-throw if it's our own business-logic collision errors
    const errorMsg = error?.message || '';
    if (errorMsg.includes("usado por outra conta") || errorMsg.includes("exatamente 9 dígitos")) {
      throw error;
    }

    console.warn('Realtime Database error in registerOrLogin, using local fallback:', error);
    const fallbackUser: AppUser = {
      username: username || "Usuário",
      phone: normalizedPhone,
      status: 'pendente',
      isVip: false,
      validity: new Date().toISOString(),
      creationDate: new Date().toISOString(),
      localHistory: []
    };
    localStorage.setItem('cached_app_user', JSON.stringify(fallbackUser));
    return fallbackUser;
  }
};

/**
 * Verifies the user status directly from Realtime Database
 */
export const verifyUserStatus = async (phone: string): Promise<AppUser | null> => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (normalizedPhone.length !== 9) {
    return null;
  }
  const path = `BAC-BOT/users/${normalizedPhone}`;
  try {
    const dbRef = ref(rtdb, path);
    const snapshot = await get(dbRef);
    if (snapshot.exists()) {
      const user = snapshot.val() as any;
      const mappedUser: AppUser = {
        username: user.username || user.nome || "Usuário",
        phone: normalizedPhone,
        status: user.status || 'pendente',
        isVip: user.vip !== undefined ? user.vip : (user.isVip !== undefined ? user.isVip : false),
        validity: user.dataExpiracao || user.validity || new Date().toISOString(),
        creationDate: user.creationDate || new Date().toISOString(),
        localHistory: user.localHistory || []
      };

      // Completely removed admin auto-active and auto-VIP in verifyUserStatus as requested!

      localStorage.setItem('cached_app_user', JSON.stringify(mappedUser));
      return mappedUser;
    }
    localStorage.removeItem('cached_app_user');
    localStorage.removeItem('bac_bot_phone');
    return null;
  } catch (error) {
    console.warn('Realtime Database error in verifyUserStatus, using local fallback:', error);
    try {
      const cachedUserStr = localStorage.getItem('cached_app_user');
      if (cachedUserStr) {
        const user = JSON.parse(cachedUserStr) as AppUser;
        if (user.phone === normalizedPhone) {
          // Forçar VIP false se offline/falha de conexão para evitar manipulação de cache local
          user.isVip = false;
          return user;
        }
      }
    } catch (err) {
      console.warn('Failed to parse cached app user', err);
    }
    
    const expirationDate = new Date();
    expirationDate.setMonth(expirationDate.getMonth() + 1);
    const fallbackUser: AppUser = {
      username: "Usuário Local",
      phone: normalizedPhone,
      status: 'pendente',
      isVip: false,
      validity: expirationDate.toISOString(),
      creationDate: new Date().toISOString(),
      localHistory: []
    };
    return fallbackUser;
  }
};

/**
 * Fetches recent rounds from Firebase Realtime Database
 */
export const getGlobalRounds = async (limitNum: number = 50): Promise<any[]> => {
  const path = 'BAC-BOT/rounds';
  try {
    const roundsRef = ref(rtdb, path);
    const snapshot = await get(roundsRef);
    if (!snapshot.exists()) {
      const localRoundsStr = localStorage.getItem('local_rounds') || '[]';
      return JSON.parse(localRoundsStr).slice(-limitNum);
    }
    
    const data = snapshot.val();
    let allRounds: any[] = [];
    if (Array.isArray(data)) {
      allRounds = data.filter(Boolean);
    } else if (typeof data === 'object') {
      allRounds = Object.values(data);
    }
    
    allRounds.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return allRounds.slice(0, limitNum);
  } catch (error) {
    console.warn('Database is Offline or failed to load. Returning local rounds history:', error);
    try {
      const localRoundsStr = localStorage.getItem('local_rounds') || '[]';
      return JSON.parse(localRoundsStr).slice(-limitNum);
    } catch (err) {
      return [];
    }
  }
};

/**
 * Records a 5-sequence block pattern transition into user-specific Realtime Database
 */
export const recordDynamicPattern = async (phone: string, sequence5: string, nextResult: string) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return;

  try {
    const localKey = `local_learned_patterns_${normalizedPhone}`;
    const localPatternsStr = localStorage.getItem(localKey) || '{}';
    const localPatterns = JSON.parse(localPatternsStr);
    if (!localPatterns[sequence5]) {
      localPatterns[sequence5] = {};
    }
    const currentCount = localPatterns[sequence5][nextResult] || 0;
    localPatterns[sequence5][nextResult] = currentCount + 1;
    localStorage.setItem(localKey, JSON.stringify(localPatterns));
  } catch (err) {
    console.warn('Failed to update local patterns cache', err);
  }

  try {
    const patternRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}/learned_patterns/${sequence5}/${nextResult}`);
    const snapshot = await get(patternRef);
    const count = snapshot.exists() ? Number(snapshot.val()) : 0;
    await set(patternRef, count + 1);
  } catch (error) {
    console.warn('Database is Offline. Saved pattern transition locally:', sequence5, '->', nextResult, error);
  }
};

/**
 * Retrieves all registered dynamic pattern transitions for a given user from Realtime Database
 */
export const getDynamicPatterns = async (phone: string): Promise<Record<string, Record<string, number>>> => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return {};

  const path = `BAC-BOT/users/${normalizedPhone}/learned_patterns`;
  try {
    const patternsRef = ref(rtdb, path);
    const snapshot = await get(patternsRef);
    let patterns: Record<string, Record<string, number>> = {};
    
    if (snapshot.exists()) {
      patterns = snapshot.val() as Record<string, Record<string, number>>;
    }

    // Merge in local data if any exists
    try {
      const localKey = `local_learned_patterns_${normalizedPhone}`;
      const localPatternsStr = localStorage.getItem(localKey) || '{}';
      const localPatterns = JSON.parse(localPatternsStr);
      for (const [key, val] of Object.entries(localPatterns)) {
        if (!patterns[key]) {
          patterns[key] = val as Record<string, number>;
        } else {
          const remoteVal = patterns[key];
          const localVal = val as Record<string, number>;
          for (const [res, count] of Object.entries(localVal)) {
            remoteVal[res] = (remoteVal[res] || 0) + count;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to merge local patterns cache', err);
    }

    return patterns;
  } catch (error) {
    console.warn('Database is Offline. Returning locally learned patterns:', error);
    try {
      const localKey = `local_learned_patterns_${normalizedPhone}`;
      const localPatternsStr = localStorage.getItem(localKey) || '{}';
      return JSON.parse(localPatternsStr);
    } catch (err) {
      return {};
    }
  }
};

/**
 * Saves a game round to user-specific directory in Realtime Database
 */
export const saveRound = async (phone: string, data: any) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return;

  const path = `BAC-BOT/users/${normalizedPhone}/rounds`;
  const roundPayload = {
    ...data,
    userId: normalizedPhone,
    timestamp: Date.now()
  };

  // Always cache locally under a phone-specific key
  try {
    const localKey = `local_rounds_${normalizedPhone}`;
    const localRoundsStr = localStorage.getItem(localKey) || '[]';
    const localRounds = JSON.parse(localRoundsStr);
    localRounds.push(roundPayload);
    localStorage.setItem(localKey, JSON.stringify(localRounds.slice(-200)));
  } catch (err) {
    console.warn('Failed to cache round locally', err);
  }

  try {
    const roundsRef = ref(rtdb, path);
    const newRoundRef = push(roundsRef);
    await set(newRoundRef, roundPayload);
  } catch (error) {
    console.warn('Database is Offline. Saved round payload to local history storage.', error);
  }
};

/**
 * Fetches user-specific rounds from Firebase Realtime Database
 */
export const getUserRounds = async (phone: string, limitNum: number = 50): Promise<any[]> => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return [];
  const path = `BAC-BOT/users/${normalizedPhone}/rounds`;
  try {
    const roundsRef = ref(rtdb, path);
    const snapshot = await get(roundsRef);
    if (!snapshot.exists()) {
      const localKey = `local_rounds_${normalizedPhone}`;
      const localRoundsStr = localStorage.getItem(localKey) || '[]';
      return JSON.parse(localRoundsStr).slice(-limitNum);
    }
    
    const data = snapshot.val();
    let allRounds: any[] = [];
    if (Array.isArray(data)) {
      allRounds = data.filter(Boolean);
    } else if (typeof data === 'object') {
      allRounds = Object.values(data);
    }
    
    allRounds.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return allRounds.slice(0, limitNum);
  } catch (error) {
    console.warn('Database is Offline. Returning user local rounds history:', error);
    try {
      const localKey = `local_rounds_${normalizedPhone}`;
      const localRoundsStr = localStorage.getItem(localKey) || '[]';
      return JSON.parse(localRoundsStr).slice(-limitNum);
    } catch (err) {
      return [];
    }
  }
};

/**
 * RTDB Real-Time Listener for BAC-BOT rounds
 */
export const listenToBacBotRounds = (phone: string, callback: (rounds: Result[]) => void) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  const dbRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}/rounds_history`);
  
  return onValue(dbRef, (snapshot) => {
    let parsedRounds: Result[] = [];
    const localKey = `local_history_v2_${normalizedPhone}`;
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      if (typeof data === 'string') {
        parsedRounds = data.split(',')
          .map(s => s.trim().toUpperCase())
          .map(s => {
            if (s === 'P' || s === 'PLAYER' || s === 'AZUL') return 'PLAYER';
            if (s === 'B' || s === 'BANKER' || s === 'VERMELHO') return 'BANKER';
            if (s === 'T' || s === 'TIE' || s === 'EMPATE') return 'TIE';
            return null;
          })
          .filter((r): r is Result => r !== null);
      } else if (Array.isArray(data)) {
        parsedRounds = data
          .map(item => {
            if (typeof item === 'string') {
              const s = item.toUpperCase();
              if (s === 'P' || s === 'PLAYER' || s === 'AZUL') return 'PLAYER';
              if (s === 'B' || s === 'BANKER' || s === 'VERMELHO') return 'BANKER';
              if (s === 'T' || s === 'TIE' || s === 'EMPATE') return 'TIE';
            }
            return null;
          })
          .filter((r): r is Result => r !== null);
      }
      
      // Cache values locally
      if (parsedRounds.length > 0) {
        localStorage.setItem(localKey, JSON.stringify(parsedRounds));
      }
    } else {
      // Local fallback
      try {
        const cached = localStorage.getItem(localKey);
        if (cached) {
          parsedRounds = JSON.parse(cached);
        }
      } catch (err) {
        console.warn("Local storage parse error in listenToBacBotRounds fallback", err);
      }
      
      // Let it remain empty if nothing exists, so the user has to input all 14 rounds manually
      if (parsedRounds.length === 0) {
        parsedRounds = [];
      }
    }
    
    callback(parsedRounds.slice(-50));
  }, (error) => {
    console.error("RTDB user-isolated subscription error:", error);
    const localKey = `local_history_v2_${normalizedPhone}`;
    try {
      const cached = localStorage.getItem(localKey);
      if (cached) {
        callback(JSON.parse(cached).slice(-50));
      }
    } catch (err) {
      console.warn("Offline user-isolated callback fallback failed", err);
    }
  });
};

/**
 * Saves a new round directly to user-specific Realtime Database path
 */
export const saveBacBotRound = async (phone: string, result: Result) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return;

  try {
    const dbRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}/rounds_history`);
    const snapshot = await get(dbRef);
    const char = result === 'PLAYER' ? 'P' : result === 'BANKER' ? 'B' : 'T';
    
    const localKey = `local_history_v2_${normalizedPhone}`;
    let currentRounds: Result[] = [];
    
    try {
      const localCached = localStorage.getItem(localKey);
      if (localCached) {
        currentRounds = JSON.parse(localCached);
      }
    } catch (e) {
      console.warn("Local storage parse error in saveBacBotRound", e);
    }

    if (snapshot.exists()) {
      const data = snapshot.val();
      let parsedDb: Result[] = [];
      if (typeof data === 'string') {
        parsedDb = data.split(',').map(s => {
          const su = s.trim().toUpperCase();
          if (su === 'P' || su === 'PLAYER' || su === 'AZUL') return 'PLAYER';
          if (su === 'B' || su === 'BANKER' || su === 'VERMELHO') return 'BANKER';
          return 'TIE';
        });
      } else if (Array.isArray(data)) {
        parsedDb = data;
      }
      if (parsedDb.length > 0) {
        currentRounds = parsedDb;
      }
    }

    const updatedRounds = [...currentRounds, result].slice(-50);
    localStorage.setItem(localKey, JSON.stringify(updatedRounds));
    
    await set(dbRef, updatedRounds.join(','));
  } catch (error) {
    console.error("Failed to save user-specific round to RTDB:", error);
  }
};

/**
 * Overwrites the entire user-specific history in Realtime Database (e.g. for undo)
 */
export const setBacBotHistory = async (phone: string, rounds: Result[]) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return;

  try {
    const dbRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}/rounds_history`);
    const localKey = `local_history_v2_${normalizedPhone}`;
    
    localStorage.setItem(localKey, JSON.stringify(rounds));
    await set(dbRef, rounds.join(','));
  } catch (error) {
    console.error("Failed to set user-specific history path in RTDB:", error);
  }
};

/**
 * Interface definition for remote configurations
 */
export interface BacBotRemoteConfig {
  dialog: {
    ativo: boolean;
    titulo: string;
    mensagem: string;
    tipo: 'info' | 'success' | 'warning' | 'error';
  };
  foto: string;
  gales: {
    ativo: boolean;
    nivel: number; 
  };
  manutencao: {
    ativo: boolean;
    mensagem: string;
    dataFim: string; 
  };
  liberado: {
    ativo: boolean;
    dataFim: string; 
  };
  canal?: string;
  suporte?: string;
}

/**
 * Records predictions, matched patterns, outcome hits and what with high precision inside a neat section: BAC-BOT/historico_padroes
 */
export const recordPatternOutcome = async (
  phone: string, 
  patternName: string, 
  predictedResult: Result, 
  actualResult: Result,
  wasCorrect: boolean
) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone || !patternName) return;

  const bResult = actualResult === 'PLAYER' ? 'P' : actualResult === 'BANKER' ? 'B' : 'T';
  const pResult = predictedResult === 'PLAYER' ? 'P' : predictedResult === 'BANKER' ? 'B' : 'T';

  // Clean alphanumeric pattern keys
  const safePatternName = patternName
    .replace(/[.#$[\]]/g, '_') // Firebase prohibited characters
    .trim();

  try {
    // 1. User isolated stats
    const userPatternRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}/padroes_registro/${safePatternName}`);
    const userSnap = await get(userPatternRef);
    let uData = userSnap.exists() ? userSnap.val() : { totalAttempts: 0, totalHits: 0, resultsDistribution: {} };
    if (typeof uData !== 'object' || uData === null) {
      uData = { totalAttempts: 0, totalHits: 0, resultsDistribution: {} };
    }
    uData.totalAttempts = (uData.totalAttempts || 0) + 1;
    if (wasCorrect) {
      uData.totalHits = (uData.totalHits || 0) + 1;
    }
    if (!uData.resultsDistribution) uData.resultsDistribution = {};
    uData.resultsDistribution[bResult] = (uData.resultsDistribution[bResult] || 0) + 1;
    uData.hitRate = Number((uData.totalHits / uData.totalAttempts).toFixed(3));
    await set(userPatternRef, uData);

    // 2. Global / Section-wide stats for all users safely organized inside BAC-BOT/historico_padroes
    const globalPatternRef = ref(rtdb, `BAC-BOT/historico_padroes/${safePatternName}`);
    const globalSnap = await get(globalPatternRef);
    let gData = globalSnap.exists() ? globalSnap.val() : { totalAttempts: 0, totalHits: 0, resultsDistribution: {} };
    if (typeof gData !== 'object' || gData === null) {
      gData = { totalAttempts: 0, totalHits: 0, resultsDistribution: {} };
    }
    gData.totalAttempts = (gData.totalAttempts || 0) + 1;
    if (wasCorrect) {
      gData.totalHits = (gData.totalHits || 0) + 1;
    }
    if (!gData.resultsDistribution) gData.resultsDistribution = {};
    gData.resultsDistribution[bResult] = (gData.resultsDistribution[bResult] || 0) + 1;
    gData.hitRate = Number((gData.totalHits / gData.totalAttempts).toFixed(3));
    await set(globalPatternRef, gData);

  } catch (error) {
    console.warn("Failed to record pattern outcome in secure section:", error);
  }
};

/**
 * Interface for live stats
 */
export interface BacBotLiveStats {
  total: number;
  acertos: number;
  perdas: number;
  taxaAcerto?: number;
}

/**
 * Listens to remote configs in real-time under BAC-BOT/config
 */
export const listenToBacBotConfig = (callback: (config: BacBotRemoteConfig) => void) => {
  const configRef = ref(rtdb, 'BAC-BOT/config');
  
  return onValue(configRef, (snapshot) => {
    const defaultVal: BacBotRemoteConfig = {
      dialog: { ativo: false, titulo: '', mensagem: '', tipo: 'info' },
      foto: 'https://i.ibb.co/qMK7k8fW/IMG-20260604-WA2608.webp',
      gales: { ativo: true, nivel: 2 },
      manutencao: { ativo: false, mensagem: 'O terminal está em manutenção técnica. Por favor, aguarde.', dataFim: '' },
      liberado: { ativo: false, dataFim: '' },
      canal: 'https://whatsapp.com/channel/0029VbDDmW98KMqi9YkzwU1',
      suporte: '998554117'
    };
    
    if (!snapshot.exists()) {
      set(configRef, defaultVal).catch(err => console.error("Failed to seed config:", err));
      callback(defaultVal);
      return;
    }
    
    const data = snapshot.val() || {};
    
    // Proactively check and patch missing keys in real time so that they always show up in database
    let needsUpdate = false;
    if (data.canal === undefined) {
      data.canal = defaultVal.canal;
      needsUpdate = true;
    }
    if (data.suporte === undefined) {
      data.suporte = defaultVal.suporte;
      needsUpdate = true;
    }
    if (data.foto === undefined || data.foto === 'https://i.ibb.co/WWvnrxXN/images-22.webp') {
      data.foto = defaultVal.foto;
      needsUpdate = true;
    }
    if (needsUpdate) {
      update(configRef, {
        canal: data.canal,
        suporte: data.suporte,
        foto: data.foto
      }).catch(err => console.error("Failed to silently patch missing config in RTDB:", err));
    }

    const merged = {
      dialog: {
        ativo: (data.dialog?.ativo !== undefined) ? data.dialog.ativo : (data.dialog?.mensagem ? true : false),
        titulo: data.dialog?.titulo || '',
        mensagem: data.dialog?.mensagem || '',
        tipo: data.dialog?.tipo || 'info'
      },
      foto: data.foto || defaultVal.foto,
      gales: { ...defaultVal.gales, ...data.gales },
      manutencao: { ...defaultVal.manutencao, ...data.manutencao },
      liberado: { ...defaultVal.liberado, ...data.liberado },
      canal: data.canal || defaultVal.canal,
      suporte: data.suporte || defaultVal.suporte
    };
    callback(merged);
  });
};

/**
 * Listens to aggregated real-time statistics under BAC-BOT/stats
 */
export const listenToBacBotStats = (callback: (stats: BacBotLiveStats) => void) => {
  const statsRef = ref(rtdb, 'BAC-BOT/stats');
  
  return onValue(statsRef, (snapshot) => {
    const defaultStats: BacBotLiveStats = { total: 2505, acertos: 2403, perdas: 102 };
    if (!snapshot.exists()) {
      // Seed default statistics so the database is never completely empty or reset to 0
      set(statsRef, defaultStats).catch(err => console.error("Failed to seed initial stats:", err));
      callback(defaultStats);
      return;
    }
    const data = snapshot.val();
    const total = Number(data.total) || 0;
    const acertos = Number(data.acertos || data.wins) || 0;
    const perdas = Number(data.perdas || data.losses) || 0;
    
    // Fallback if data exists as completely zeroed out
    if (total === 0) {
      callback(defaultStats);
    } else {
      callback({ total, acertos, perdas });
    }
  });
};

/**
 * Atomically increments the real general statistics in Firebase Database (syncing both paths)
 */
export const incrementBacBotStats = async (isWin: boolean) => {
  try {
    const statsRef = ref(rtdb, 'BAC-BOT/stats');
    const snapshot = await get(statsRef);
    let current = { total: 0, acertos: 0, perdas: 0 };
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      current = {
        total: Number(data.total) || 0,
        acertos: Number(data.acertos || data.wins) || 0,
        perdas: Number(data.perdas || data.losses) || 0
      };
    }
    
    const nextStats = {
      total: current.total + 1,
      acertos: isWin ? current.acertos + 1 : current.acertos,
      perdas: !isWin ? current.perdas + 1 : current.perdas
    };
    
    await set(statsRef, nextStats);
  } catch (error) {
    console.error("Failed to increment BAC-BOT stats:", error);
  }
};

/**
 * Sets user active state in real time under BAC-BOT/users/{normalizedPhone}
 */
export const updateUserActivity = async (
  phone: string,
  username: string,
  isVip: boolean,
  validity: string,
  status: string,
  sessionToken: string
) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  if (!normalizedPhone) return;
  
  const userRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}`);
  try {
    const snapshot = await get(userRef);
    if (!snapshot.exists()) {
      // If the user profile does not exist in Firebase (e.g. was deleted), do not recreate it!
      return;
    }
    const existing = snapshot.val();
    
    await set(userRef, {
      ...existing,
      username: existing.username || username,
      phone: normalizedPhone,
      isVip: existing.isVip !== undefined ? existing.isVip : (existing.vip !== undefined ? existing.vip : isVip),
      vip: existing.vip !== undefined ? existing.vip : (existing.isVip !== undefined ? existing.isVip : isVip),
      validity: existing.validity || validity,
      dataExpiracao: existing.dataExpiracao || existing.validity || validity,
      status: existing.status || status,
      sessionId: sessionToken,
      sessionToken,
      lastActive: new Date().toISOString(),
      lastActiveTime: Date.now()
    });
  } catch (err) {
    console.warn("Failed to set user activity in RTDB:", err);
  }
};

/**
 * Listens to active user profile block/status/sessions in real-time under BAC-BOT/users/{phone}
 */
export const listenToUserProfile = (phone: string, callback: (user: any) => void) => {
  const normalizedPhone = phone.replace(/\D/g, '');
  const userRef = ref(rtdb, `BAC-BOT/users/${normalizedPhone}`);
  
  return onValue(userRef, (snapshot) => {
    if (snapshot.exists()) {
      callback(snapshot.val());
    } else {
      callback(null);
    }
  });
};
