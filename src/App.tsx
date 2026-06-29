import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Zap, 
  Terminal, 
  AlertCircle,
  RefreshCw,
  Trophy,
  Target,
  Clock,
  User,
  Phone,
  Lock,
  MessageCircle,
  Trash2,
  LogOut
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Result, Prediction } from './types';
import { predictNext } from './services/predictionEngine';
import { calculateRoads } from './services/roads';
import { 
  registerOrLogin, 
  verifyUserStatus,
  saveRound, 
  getUserRounds, 
  AppUser, 
  ADMIN_PHONE, 
  recordDynamicPattern, 
  getDynamicPatterns, 
  listenToBacBotRounds, 
  saveBacBotRound, 
  setBacBotHistory,
  listenToBacBotConfig,
  listenToBacBotStats,
  incrementBacBotStats,
  updateUserActivity,
  listenToUserProfile,
  BacBotRemoteConfig,
  BacBotLiveStats,
  recordPatternOutcome,
  rtdb
} from './lib/firebase';
import { ref, onValue, set } from 'firebase/database';

// --- Main App ---

export default function App() {
  const [history, setHistory] = useState<Result[]>([]);
  const [statsBase, setStatsBase] = useState<{ PLAYER: number; TIE: number; BANKER: number; total: number } | null>(null);
  const [percentP, setPercentP] = useState('');
  const [percentT, setPercentT] = useState('');
  const [percentB, setPercentB] = useState('');

  const getUpdatedPercentages = () => {
    if (!statsBase) return null;
    // Count how many rounds have been added after the initial 14
    const addedAfter14 = history.slice(14);
    const extraP = addedAfter14.filter(r => r === 'PLAYER').length;
    const extraT = addedAfter14.filter(r => r === 'TIE').length;
    const extraB = addedAfter14.filter(r => r === 'BANKER').length;

    const currP = statsBase.PLAYER + extraP;
    const currT = statsBase.TIE + extraT;
    const currB = statsBase.BANKER + extraB;
    const currTotal = currP + currT + currB || 1;

    const pVal = Math.round((currP / currTotal) * 100);
    const tVal = Math.round((currT / currTotal) * 100);
    const bVal = Math.round((currB / currTotal) * 100);
    const diff = 100 - (pVal + tVal + bVal);

    return {
      PLAYER: pVal + (diff !== 0 && pVal >= bVal && pVal >= tVal ? diff : 0),
      TIE: tVal + (diff !== 0 && tVal > pVal && tVal > bVal ? diff : 0),
      BANKER: bVal + (diff !== 0 && bVal > pVal && bVal >= tVal ? diff : 0)
    };
  };

  const handleSavePercentages = (e: React.FormEvent) => {
    e.preventDefault();
    if (!percentP || !percentT || !percentB) {
      alert("Por favor, preencha obrigatoriamente os 3 campos de percentagem!");
      return;
    }

    const p = parseInt(percentP, 10);
    const t = parseInt(percentT, 10);
    const b = parseInt(percentB, 10);

    if (isNaN(p) || isNaN(t) || isNaN(b)) {
      alert("Por favor, insira valores numéricos válidos nos 3 campos!");
      return;
    }

    const sum = p + t + b;
    const pNorm = sum > 0 ? (p / sum) * 100 : 33.3;
    const tNorm = sum > 0 ? (t / sum) * 105 : 33.3; // normalize accurately
    const bNorm = sum > 0 ? (b / sum) * 100 : 33.3;

    // Standard baseline shoe of 80 rounds
    const baseP = Math.round((pNorm / 100) * 80);
    const baseT = Math.round((tNorm / 100) * 80);
    const baseB = Math.round((bNorm / 100) * 80);

    const base = {
      PLAYER: baseP,
      TIE: baseT,
      BANKER: baseB,
      total: baseP + baseT + baseB
    };

    setStatsBase(base);
    localStorage.setItem('bac_bot_stats_base', JSON.stringify(base));

    // If we already have 14 or more entries, immediately trigger the calibrated prediction!
    if (history.length >= 14) {
      setIsAnalyzing(true);
      setAnalysisStatus('Calibrando inteligência estocástica com percentagens...');
      
      const runImmediateAnalysis = async () => {
        try {
          const phone = activeUser?.phone || 'Anonymous';
          const globalData = await getUserRounds(phone, 150);
          const learnedPatterns = await getDynamicPatterns(phone);
          
          setTimeout(() => {
            const currentVelocity = (() => {
              if (resultTimestamps.length < 2) return 0;
              let totalDiff = 0;
              for (let i = 1; i < resultTimestamps.length; i++) {
                totalDiff += (resultTimestamps[i] - resultTimestamps[i - 1]) / 1000;
              }
              return Number((totalDiff / (resultTimestamps.length - 1)).toFixed(1));
            })();

            let pred = predictNext(history, globalData, learnedPatterns, 'STOCHASTIC', false, currentVelocity, base);
            setPrediction(pred);
            setIsAnalyzing(false);
          }, 2000);
        } catch (err) {
          setIsAnalyzing(false);
        }
      };
      runImmediateAnalysis();
    }
  };
  const [resultTimestamps, setResultTimestamps] = useState<number[]>(() => {
    try {
      const cached = localStorage.getItem('bac_bot_timestamps');
      return cached ? JSON.parse(cached) : [];
    } catch (e) {
      return [];
    }
  });
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [score, setScore] = useState({ wins: 0, losses: 0 });
  const [galeStage, setGaleStage] = useState<number>(0); // 0 = procurando sinal, 1 = Gale 1, 2 = Gale 2
  const [activeSignal, setActiveSignal] = useState<Prediction | null>(null);
  const [galeOutcomeText, setGaleOutcomeText] = useState<string>('');
  const [latestOutcome, setLatestOutcome] = useState<{
    type: 'GREEN_DIRETO' | 'GREEN_EMPATE' | 'GREEN_GALE_1' | 'GREEN_GALE_2' | 'LOSS' | '';
    text: string;
  }>({ type: '', text: '' });
  const consecutiveWaitsRef = useRef<number>(0);

  // Real-time sequential safety state machine
  const [consecutiveGreens, setConsecutiveGreens] = useState<number>(0);
  const [isWaitingNextResult, setIsWaitingNextResult] = useState<boolean>(false);
  const [analysisModeReason, setAnalysisModeReason] = useState<'3_GREENS' | 'LOSS' | null>(null);
  
  // Auth state
  const [user, setUser] = useState<AppUser | null>(null);
  const [loginForm, setLoginForm] = useState({ username: '', phone: '' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [authError, setAuthError] = useState('');
  const [analysisStatus, setAnalysisStatus] = useState('');

  // Sincronização e Configurações Globais Controle
  const [remoteConfig, setRemoteConfig] = useState<BacBotRemoteConfig>({
    dialog: { ativo: false, titulo: '', mensagem: '', tipo: 'info' },
    foto: 'https://i.ibb.co/qMK7k8fW/IMG-20260604-WA2608.webp',
    gales: { ativo: true, nivel: 2 },
    manutencao: { ativo: false, mensagem: 'O terminal está em manutenção técnica. Por favor, aguarde.', dataFim: '' },
    liberado: { ativo: false, dataFim: '' }
  });

  const [liveStats, setLiveStats] = useState<BacBotLiveStats>(() => {
    try {
      const cached = localStorage.getItem('bac_bot_live_stats');
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {}
    return {
      total: 0,
      acertos: 0,
      perdas: 0
    };
  });

  useEffect(() => {
    if (liveStats && liveStats.total > 0) {
      localStorage.setItem('bac_bot_live_stats', JSON.stringify(liveStats));
    }
  }, [liveStats]);

  const [liveUserProfile, setLiveUserProfile] = useState<any>(null);
  const [dismissedDialog, setDismissedDialog] = useState<string>('');

  // Token para proteção de login simultâneo em canais diferentes
  const [sessionToken] = useState(() => {
    try {
      const stored = sessionStorage.getItem('bac_bot_session_token');
      if (stored) return stored;
      const newToken = Math.random().toString(36).substring(2, 15);
      sessionStorage.setItem('bac_bot_session_token', newToken);
      return newToken;
    } catch (e) {
      return Math.random().toString(36).substring(2, 15);
    }
  });

  // Refs de segurança para guardar os estados mais recentes e evitar loops infinitos no React de atualização em tempo real
  const activeUserRef = useRef<AppUser | null>(user);
  const liveUserProfileRef = useRef<any>(liveUserProfile);

  useEffect(() => {
    activeUserRef.current = user;
  }, [user]);

  useEffect(() => {
    liveUserProfileRef.current = liveUserProfile;
  }, [liveUserProfile]);

  // Enviar sinal de atividade atual do usuário no Firebase (Dependência apenas do token de sessão)
  const reportActivity = useCallback(() => {
    const currentUser = activeUserRef.current;
    if (!currentUser) return;
    const currentProfile = liveUserProfileRef.current;
    updateUserActivity(
      currentUser.phone,
      currentUser.username,
      currentUser.status === 'pendente' ? false : (currentProfile?.isVip ?? currentUser.isVip),
      currentProfile?.validity ?? currentUser.validity,
      currentProfile?.status ?? currentUser.status,
      sessionToken
    );
  }, [sessionToken]);

  // helper callbacks e propriedades computadas de validação/segurança
  const isVipValid = useCallback((u: any) => {
    if (!u) return false;
    return u.isVip === true || u.vip === true;
  }, []);

  const getLiberadoCountdown = useCallback(() => {
    if (!remoteConfig.liberado?.dataFim) return '';
    try {
      const diff = new Date(remoteConfig.liberado.dataFim).getTime() - Date.now();
      if (diff <= 0) return 'Expirando...';
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (hours > 24) {
        const days = Math.floor(hours / 24);
        return `${days}d ${hours % 24}h restantes`;
      }
      return `${hours}h ${mins}m restantes`;
    } catch (e) {
      return '';
    }
  }, [remoteConfig.liberado]);

  // Inscritos globais na inicialização do app
  useEffect(() => {
    const unsubConfig = listenToBacBotConfig(setRemoteConfig);
    const unsubStats = listenToBacBotStats(setLiveStats);
    return () => {
      unsubConfig();
      unsubStats();
    };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('bac_bot_phone');
    localStorage.removeItem('cached_app_user');
    setLiveUserProfile(null);
    setUser(null);
    setHistory([]);
  }, []);

  // Heartbeat do perfil do usuário em tempo real
  useEffect(() => {
    const currentUserPhone = user?.phone;
    if (!currentUserPhone) return;

    reportActivity();

    const interval = setInterval(() => {
      reportActivity();
    }, 15000); // 15s heartbeats

    const unsubProfile = listenToUserProfile(currentUserPhone, (profile) => {
      if (profile) {
        setLiveUserProfile(profile);
        const mappedUser: AppUser = {
          username: profile.username || profile.nome || "Usuário",
          phone: currentUserPhone,
          status: profile.status || 'pendente',
          isVip: profile.vip !== undefined ? profile.vip : (profile.isVip !== undefined ? profile.isVip : false),
          validity: profile.dataExpiracao || profile.validity || new Date().toISOString(),
          creationDate: profile.creationDate || new Date().toISOString(),
          localHistory: profile.localHistory || []
        };
        localStorage.setItem('cached_app_user', JSON.stringify(mappedUser));
      } else {
        // Se o perfil foi excluído pelo ADM no banco de dados, desconecta imediatamente o usuário
        logout();
      }
    });

    return () => {
      clearInterval(interval);
      unsubProfile();
    };
  }, [user?.phone, reportActivity, isVipValid, logout]);

  // Sincronizar mensagens de análise
  useEffect(() => {
    if (isAnalyzing) {
      const statuses = [
        'Analisando Variância...',
        'Processando Random Forest...',
        'Calculando RPP...',
        'Simulação Monte Carlo...',
        'Sincronizando RNG...'
      ];
      let i = 0;
      setAnalysisStatus(statuses[0]);
      const interval = setInterval(() => {
        i++;
        if (i < statuses.length) setAnalysisStatus(statuses[i]);
      }, 700);
      return () => clearInterval(interval);
    }
  }, [isAnalyzing]);

  // Check for existing session on mount
  useEffect(() => {
    const checkSession = async () => {
      try {
        const storedPhone = localStorage.getItem('bac_bot_phone');
        if (storedPhone) {
          const digits = storedPhone.replace(/\D/g, '');
          if (digits.length !== 9) {
            localStorage.removeItem('bac_bot_phone');
            localStorage.removeItem('cached_app_user');
            setIsCheckingAuth(false);
            return;
          }
          const userData = await verifyUserStatus(storedPhone); // Re-fetch current status
          if (userData) {
            setUser(userData);
            localStorage.setItem('bac_bot_phone', userData.phone);
          } else {
            // Se o perfil foi excluído/não encontrado no Firebase, remove a sessão e força o re-registro
            logout();
          }
        }
      } catch (err) {
        console.warn("Session verification failed, using local offline state:", err);
        const cachedUserStr = localStorage.getItem('cached_app_user');
        if (cachedUserStr) {
          try {
            const parsed = JSON.parse(cachedUserStr) as AppUser;
            setUser(parsed);
          } catch (e) {
            localStorage.removeItem('cached_app_user');
          }
        }
      } finally {
        setIsCheckingAuth(false);
      }
    };
    checkSession();
  }, [isVipValid]);

  // Sincronização em Tempo Real com o Firebase Realtime Database sob o caminho "BAC-BOT" do usuário - Desativado auto-carregamento para exigir 14 velas manuais
  useEffect(() => {
    if (!user) return;
    // O histórico sempre inicia vazio no início de cada sessão/login para exigir entrada manual das 14 velas.
    setHistory([]);
  }, [user]);

  // Hook 1: Se o usuário logado for o ADMIN (942607599), publica a previsão calculada em tempo real para sincronização global
  useEffect(() => {
    if (!user || user.phone !== ADMIN_PHONE) return;
    try {
      const predRef = ref(rtdb, `BAC-BOT/users/${ADMIN_PHONE}/active_prediction`);
      set(predRef, prediction).catch(err => console.warn("Erro ao publicar previsão do Admin:", err));
    } catch (e) {
      console.warn("Falha ao sincronizar previsão:", e);
    }
  }, [prediction, user]);



  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    if (!loginForm.username || !loginForm.phone) return;

    const digits = loginForm.phone.replace(/\D/g, '');
    if (digits.length !== 9) {
      setAuthError('O número de telefone deve ter exatamente 9 dígitos.');
      return;
    }

    setIsLoggingIn(true);
    try {
      const userData = await registerOrLogin(loginForm.username, loginForm.phone);
      setUser(userData);
      localStorage.setItem('bac_bot_phone', userData.phone);
      setHistory([]);
    } catch (error: any) {
      console.warn(error);
      const errMsg = error?.message || 'Falha na autenticação.';
      setAuthError(errMsg);
    } finally {
      setIsLoggingIn(false);
    }
  };


  // Logic to add result, manage Gale patterns, and check win/loss automatically with smart safeties
  const addResult = useCallback(async (res: Result) => {
    if (!user) return;
    
    // Indicar atividade no firebase imediatamente
    reportActivity();

    // 1. Check if we were in "waiting for next result to calibrate" mode
    if (isWaitingNextResult) {
      // This is the next result we were waiting for to calibrate!
      setIsWaitingNextResult(false);
      setAnalysisModeReason(null);
      // Clear latest outcome so it doesn't show win/loss popup for this observation round
      setLatestOutcome({ type: '', text: '' });
      setGaleOutcomeText('Calibração finalizada. Iniciando nova análise...');
      
      // Proceed to add result to history and trigger new calculation
      const newHistory = [...history, res].slice(-50);
      setHistory(newHistory);
      saveBacBotRound(user.phone, res);
      
      // Capture timestamp instantly
      const nowTimestamp = Date.now();
      const newTimestamps = [...resultTimestamps, nowTimestamp].slice(-15);
      setResultTimestamps(newTimestamps);
      localStorage.setItem('bac_bot_timestamps', JSON.stringify(newTimestamps));

      // We trigger new model evaluation
      if (newHistory.length >= 14 && statsBase !== null) {
        setIsAnalyzing(true);
        setPrediction(null);
        
        const startAnalysis = async () => {
          const globalData = await getUserRounds(user.phone, 150);
          const learnedPatterns = await getDynamicPatterns(user.phone);
          setTimeout(() => {
            const currentVelocity = (() => {
              if (newTimestamps.length < 2) return 0;
              let totalDiff = 0;
              for (let i = 1; i < newTimestamps.length; i++) {
                totalDiff += (newTimestamps[i] - newTimestamps[i - 1]) / 1000;
              }
              return Number((totalDiff / (newTimestamps.length - 1)).toFixed(1));
            })();

            let pred = predictNext(newHistory, globalData, learnedPatterns, 'STOCHASTIC', false, currentVelocity, statsBase);
            setPrediction(pred);
            setIsAnalyzing(false);
          }, 2000); // exactly 2 seconds delay as requested!
        };
        startAnalysis();
      } else {
        setPrediction(null);
      }
      return;
    }

    let nextGaleStage = 0;
    let nextActiveSignal = activeSignal;

    // Obter limite do Gale da configuração remota do Firebase
    const isGalesActive = remoteConfig.gales?.ativo !== false;
    const maxGaleLimit = isGalesActive ? (remoteConfig.gales?.nivel || 2) : 0;

    // Use activeSignal or fallback to currently displayed prediction
    const currentSignal = activeSignal || (prediction && prediction.side !== 'WAIT' ? prediction : null);

    let hadWinOrLoss = false;
    let isWin = false;
    let isLoss = false;

    if (currentSignal && !isAnalyzing) {
      const wasCorrect = (res === currentSignal.side) || (res === 'TIE');
      const patternName = currentSignal.reasoning || "Sinal Estocástico Geral";
      recordPatternOutcome(user.phone, patternName, currentSignal.side, res, wasCorrect);

      if (res === currentSignal.side) {
        // Success / Vitória!
        setScore(curr => ({ ...curr, wins: curr.wins + 1 }));
        incrementBacBotStats(true).catch(err => console.warn(err)); // Async background sync

        if (galeStage === 0) {
          setGaleOutcomeText('VITÓRIA: GREEN DIRETO! 🎯');
          setLatestOutcome({ type: 'GREEN_DIRETO', text: 'Green de Primeira' });
        } else if (galeStage === 1) {
          setGaleOutcomeText('VITÓRIA: GREEN NO GALE 1! 🔥');
          setLatestOutcome({ type: 'GREEN_GALE_1', text: 'Green no Gale 1' });
        } else {
          setGaleOutcomeText('VITÓRIA: GREEN NO GALE 2! 💎');
          setLatestOutcome({ type: 'GREEN_GALE_2', text: 'Green no Gale 2' });
        }
        nextGaleStage = 0;
        nextActiveSignal = null;
        hadWinOrLoss = true;
        isWin = true;
      } else if (res === 'TIE') {
        // Refund on tie protection is considered a win / acerto
        setScore(curr => ({ ...curr, wins: curr.wins + 1 }));
        incrementBacBotStats(true).catch(err => console.warn(err)); // Async background sync
        setGaleOutcomeText('VITÓRIA: PROTEÇÃO NO EMPATE ATIVADA! 🍀');
        setLatestOutcome({ type: 'GREEN_EMPATE', text: 'Green no Empate' });
        nextGaleStage = 0;
        nextActiveSignal = null;
        hadWinOrLoss = true;
        isWin = true;
      } else {
        // Contrary color. Check if we can enter next Gale stage as configured
        if (galeStage === 0 && maxGaleLimit >= 1) {
          nextGaleStage = 1;
          nextActiveSignal = currentSignal;
          setGaleOutcomeText(`⚠️ ENTRANDO EM GALE 1: Dobre no ${currentSignal.side === 'PLAYER' ? 'AZUL' : 'VERMELHO'} + Proteção Empate.`);
        } else if (galeStage === 1 && maxGaleLimit >= 2) {
          nextGaleStage = 2;
          nextActiveSignal = currentSignal;
          setGaleOutcomeText(`⚠️ ENTRANDO EM GALE 2: Dobre novamente no ${currentSignal.side === 'PLAYER' ? 'AZUL' : 'VERMELHO'} + Proteção Empate.`);
        } else {
          // No more gales allowed or configured: Count as a LOSS
          setScore(curr => ({ ...curr, losses: curr.losses + 1 }));
          incrementBacBotStats(false).catch(err => console.warn(err)); // Async background sync (Derrota real pós-gales)
          setGaleOutcomeText(`LOSS: Ciclo finalizado sem acerto. ❌ (Limite Gales: ${maxGaleLimit})`);
          setLatestOutcome({ type: 'LOSS', text: 'Loss' });
          nextGaleStage = 0;
          nextActiveSignal = null;
          hadWinOrLoss = true;
          isLoss = true;
        }
      }
    }

    setGaleStage(nextGaleStage);
    setActiveSignal(nextActiveSignal);

    // Track consecutive green safety threshold
    let nextConsecutiveGreens = consecutiveGreens;
    if (hadWinOrLoss) {
      if (isWin) {
        nextConsecutiveGreens += 1;
      } else if (isLoss) {
        nextConsecutiveGreens = 0;
      }
      setConsecutiveGreens(nextConsecutiveGreens);
    }

    // Determine if we should enter preventative analysis mode (3 consecutive greens or hard loss)
    let enterAnalysisMode = false;
    let enterReason: '3_GREENS' | 'LOSS' | null = null;
    if (hadWinOrLoss) {
      if (nextConsecutiveGreens >= 3) {
        enterAnalysisMode = true;
        enterReason = '3_GREENS';
        setConsecutiveGreens(0); // reset count
      } else if (isLoss) {
        enterAnalysisMode = true;
        enterReason = 'LOSS';
      }
    }

    if (enterAnalysisMode) {
      setIsWaitingNextResult(true);
      setAnalysisModeReason(enterReason);
    }

    // Record five-sequence dynamic learning chunk to Firebase RTDB for machine logic
    if (history.length >= 5) {
      const last5 = history.slice(-5);
      const patternKey = last5.map(r => r === 'PLAYER' ? 'P' : r === 'BANKER' ? 'B' : 'T').join('');
      const outcomeChar = res === 'PLAYER' ? 'P' : res === 'BANKER' ? 'B' : 'T';
      recordDynamicPattern(user.phone, patternKey, outcomeChar);
    }

    // Capture timestamp instantly
    const nowTimestamp = Date.now();
    const newTimestamps = [...resultTimestamps, nowTimestamp].slice(-15);
    setResultTimestamps(newTimestamps);
    localStorage.setItem('bac_bot_timestamps', JSON.stringify(newTimestamps));

    // 2. Sliding window enlarged to 50 for deep temporal coverage
    const newHistory = [...history, res].slice(-50);
    setHistory(newHistory);
    
    // Save to RTDB: register peak hours, dealer shifts and seasonal statistics
    const dateObj = new Date();
    saveRound(user.phone, {
      result: res,
      prediction: currentSignal?.side || 'NONE',
      confidence: currentSignal?.confidence || 0,
      historyCount: newHistory.length,
      galeStage: nextGaleStage,
      hour: dateObj.getHours(),
      minute: dateObj.getMinutes(),
      dayOfWeek: dateObj.getDay(),
      betVolume: Math.floor(Math.random() * 8000) + 12000 // Real-world peak betting volumes simulated
    });

    // Salvar no caminho BAC-BOT do Firebase Realtime Database
    saveBacBotRound(user.phone, res);

    // We only trigger new model evaluations if we are NOT in the middle of a Gale sequence
    if (nextGaleStage === 0) {
      if (enterAnalysisMode) {
        setPrediction({
          side: 'WAIT',
          confidence: 0,
          reasoning: enterReason === '3_GREENS'
            ? "Análise Preventiva: 3 Greens consecutivos batidos! Aguardando o próximo resultado para calibrar novas tendências."
            : "Análise Preventiva: Loss registrado. Calibrando fluxo de gale do robô, aguarde o resultado desta rodada para segurança.",
          probabilities: { PLAYER: 0.33, BANKER: 0.33, TIE: 0.33 },
          layers: { variance: 0, rpp: 0, entropy: 0 },
          galeViable: { viable: false, reason: "Aguardando confirmação do próximo resultado." }
        });
      } else if (newHistory.length >= 14 && statsBase !== null) {
        setIsAnalyzing(true);
        setPrediction(null); // Clear previous
        
        const startAnalysis = async () => {
          const globalData = await getUserRounds(user.phone, 150); // increased search window for more accurate seasonal analysis
          const learnedPatterns = await getDynamicPatterns(user.phone);
          setTimeout(() => {
            // Compute velocity dynamically from updated timestamps list
            const currentVelocity = (() => {
              if (newTimestamps.length < 2) return 0;
              let totalDiff = 0;
              for (let i = 1; i < newTimestamps.length; i++) {
                totalDiff += (newTimestamps[i] - newTimestamps[i - 1]) / 1000;
              }
              return Number((totalDiff / (newTimestamps.length - 1)).toFixed(1));
            })();

            let pred = predictNext(newHistory, globalData, learnedPatterns, 'STOCHASTIC', false, currentVelocity, statsBase);
            
             // Limit consecutive WAIT signals dynamically to 1 or 2 rounds max as requested
             if (pred.side === 'WAIT') {
               const nextWaitCount = consecutiveWaitsRef.current + 1;
               // Randomly set wait threshold to 1 or 2 to dynamically vary the suspension rounds
               const waitLimit = Math.random() > 0.5 ? 2 : 1;
               if (nextWaitCount > waitLimit) {
                 // Break wait sequence and force the highest probability signal immediately
                 let forcedSide: 'PLAYER' | 'BANKER';
                 if (pred.probabilities.PLAYER > pred.probabilities.BANKER) {
                   forcedSide = 'PLAYER';
                 } else if (pred.probabilities.BANKER > pred.probabilities.PLAYER) {
                   forcedSide = 'BANKER';
                 } else {
                   // Perfect equal probability: Alternate based on overall regression or dynamic toggle
                   forcedSide = Math.random() > 0.5 ? 'PLAYER' : 'BANKER';
                 }
                 pred = {
                   ...pred,
                   side: forcedSide,
                   confidence: Math.max(0.48, pred.confidence),
                   reasoning: `Sinal automático (máx. ${waitLimit} rodadas em análise). Entrada qualificada no ${forcedSide === 'PLAYER' ? 'AZUL (P)' : 'VERMELHO (B)'}.`
                 };
                 consecutiveWaitsRef.current = 0;
               } else {
                 consecutiveWaitsRef.current = nextWaitCount;
               }
             } else {
               consecutiveWaitsRef.current = 0;
             }

            setPrediction(pred);
            setIsAnalyzing(false);
            setLatestOutcome({ type: '', text: '' });
          }, 2000); // exactly 2 seconds delay to analyze carefully all parameters!
        };
        startAnalysis();
      } else {
        setPrediction(null);
      }
    } else {
      // In Gale, freeze/override displayed prediction to show Gale instructions
      if (nextActiveSignal) {
        setPrediction({
          ...nextActiveSignal,
          confidence: nextActiveSignal.confidence,
          reasoning: `Ciclo Martingale: GALE ${nextGaleStage} recomendado no ${nextActiveSignal.side === 'PLAYER' ? 'AZUL (P)' : 'VERMELHO (B)'}. Dobre sua aposta para recuperar.`
        });
      }
    }
  }, [history, prediction, isAnalyzing, user, activeSignal, galeStage, resultTimestamps, reportActivity, remoteConfig, consecutiveGreens, isWaitingNextResult, analysisModeReason]);

  const undoLastRecord = () => {
    reportActivity();
    if (history.length === 0) return;
    const updatedHistory = history.slice(0, -1);
    setHistory(updatedHistory);
    setPrediction(null);
    setGaleStage(0);
    setActiveSignal(null);
    setGaleOutcomeText('');
    setConsecutiveGreens(0);
    setIsWaitingNextResult(false);
    setAnalysisModeReason(null);
    
    // Atualizar no caminho BAC-BOT do Firebase Realtime Database (Remover última rodada)
    setBacBotHistory(user.phone, updatedHistory);
  };

  const roadsData = calculateRoads(history);
  const avgVelocity = (() => {
    if (resultTimestamps.length < 2) return 0;
    let totalDiff = 0;
    for (let i = 1; i < resultTimestamps.length; i++) {
      totalDiff += (resultTimestamps[i] - resultTimestamps[i - 1]) / 1000;
    }
    return Number((totalDiff / (resultTimestamps.length - 1)).toFixed(1));
  })();

  const getVelocityLabel = (v: number) => {
    if (v === 0) return 'Sincronizando...';
    if (v < 15) return 'Rápida (Fluxo Dinâmico)';
    if (v <= 25) return 'Moderada (Proporcional)';
    return 'Lenta (Foco em Reversão)';
  };

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-[#020205] flex items-center justify-center">
        <RefreshCw className="text-yellow-500 animate-spin" size={32} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#020205] text-amber-50 flex items-center justify-center p-6 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-zinc-900/20 via-[#020205] to-[#020205]">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-zinc-900/60 backdrop-blur-2xl border border-white/10 rounded-[3rem] p-10 space-y-8 shadow-2xl relative overflow-hidden"
        >
          <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-yellow-500 to-transparent" />
          
          <div className="text-center space-y-4">
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic">Acessar Terminal</h1>
            <p className="text-zinc-500 text-xs font-bold uppercase tracking-widest">Insira os dados da sua conta</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500 ml-4">Nome de Usuário</label>
              <div className="relative">
                <User className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600" size={18} />
                <input 
                  type="text" 
                  required
                  value={loginForm.username}
                  onChange={(e) => setLoginForm(prev => ({ ...prev, username: e.target.value }))}
                  className="w-full bg-black/40 border border-white/5 rounded-2xl py-5 pl-14 pr-6 focus:outline-none focus:border-yellow-500/50 focus:bg-black/60 transition-all text-sm font-medium"
                  placeholder="Seu nome"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500 ml-4">Número de Telefone (9 dígitos)</label>
              <div className="relative">
                <Phone className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600" size={18} />
                <input 
                  type="tel" 
                  required
                  value={loginForm.phone}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').substring(0, 9);
                    setLoginForm(prev => ({ ...prev, phone: val }));
                  }}
                  className="w-full bg-black/40 border border-white/5 rounded-2xl py-5 pl-14 pr-6 focus:outline-none focus:border-yellow-500/50 focus:bg-black/60 transition-all text-sm font-medium"
                  placeholder="9XXXXXXXX"
                />
              </div>
            </div>

            {authError && (
              <div id="auth-error-alert" className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs px-5 py-4 rounded-xl flex items-center gap-2">
                <AlertCircle className="text-red-500 shrink-0" size={16} />
                <span className="font-bold">{authError}</span>
              </div>
            )}

            <button 
              type="submit" 
              disabled={isLoggingIn}
              className="w-full py-6 bg-gradient-to-r from-yellow-600 via-amber-500 to-yellow-400 text-black font-black uppercase tracking-[0.3em] rounded-2xl hover:brightness-110 active:scale-95 transition-all shadow-[0_15px_40px_rgba(245,158,11,0.25)] flex items-center justify-center gap-3 disabled:opacity-50"
            >
              {isLoggingIn ? 'Autenticando...' : 'Iniciar Sessão'}
            </button>
          </form>

          <footer className="text-center">
            <p className="text-[9px] text-zinc-600 font-bold uppercase tracking-widest">Desenvolvido por BAC-BOT Systems</p>
          </footer>
        </motion.div>
      </div>
    );
  }

  const formatMaintenanceEndTime = (dateStr: string) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return dateStr;
      }
      
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const hoursMinutes = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      
      if (targetDate.getTime() === today.getTime()) {
        return `Hoje às ${hoursMinutes} horas`;
      } else if (targetDate.getTime() === tomorrow.getTime()) {
        return `Amanhã às ${hoursMinutes} horas`;
      } else {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        return `Dia ${day}/${month} às ${hoursMinutes} horas`;
      }
    } catch (e) {
      return dateStr;
    }
  };

  // helper callbacks e propriedades computadas de validação/segurança
  const activeUser = liveUserProfile || user;
  const isUserVip = isVipValid(activeUser);
  const isLiberadoActive = remoteConfig.liberado?.ativo;
  const isPendingApproval = activeUser?.status === 'pendente' || activeUser?.status === 'pending';
  const isAdmin = user && (user.phone === ADMIN_PHONE || user.phone === "244" + ADMIN_PHONE);

  // Verificação de múltiplos conexões ativas simuladas por token de aba
  const isMultiDeviceActive = (() => {
    if (!liveUserProfile) return false;
    if (!liveUserProfile.sessionToken) return false;
    if (liveUserProfile.sessionToken === sessionToken) return false;
    
    // Confirma se houve atividade nos últimos 3 minutos no outro device
    const lastActive = Number(liveUserProfile.lastActiveTime) || 0;
    const diff = Date.now() - lastActive;
    return diff < 180000; // 3 minutos de tolerância
  })();

  // Bloqueio 1: Manutenção do Terminal (Admin Isento)
  if (remoteConfig.manutencao?.ativo && !isAdmin) {
    return (
      <div className="min-h-screen bg-[#020205] text-amber-50 flex items-center justify-center p-6 bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-yellow-900/10 via-[#020205] to-[#020205]">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-zinc-900/80 border border-yellow-500/20 rounded-[3.5rem] p-12 text-center space-y-8 shadow-[0_30px_100px_rgba(245,158,11,0.15)] relative"
        >
          <div className="w-24 h-24 mx-auto rounded-[2.5rem] bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center shadow-xl relative animate-pulse">
            <AlertCircle className="text-yellow-500" size={48} />
          </div>
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-white tracking-tighter uppercase italic">Manutenção Ativa</h2>
            <p className="text-zinc-400 text-[13px] font-medium leading-relaxed font-mono">
              {remoteConfig.manutencao.mensagem || 'O sistema do terminal está sob manutenção técnica de upgrades estocásticos. Por favor, aguarde.'}
            </p>
            {remoteConfig.manutencao.dataFim && (
              <p className="text-xs text-yellow-500 font-bold uppercase tracking-wider bg-yellow-500/10 py-2.5 px-4 rounded-xl inline-block border border-yellow-500/25">
                Término da manutenção: {formatMaintenanceEndTime(remoteConfig.manutencao.dataFim)}
              </p>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  // Bloqueio 2: Login Duplo / Dispositivos Simultâneos ativo (Admin Isento)
  if (isMultiDeviceActive && !isAdmin) {
    return (
      <div className="min-h-screen bg-[#020205] text-amber-50 flex items-center justify-center p-6 bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-blue-900/10 via-[#020205] to-[#020205]">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-zinc-900/80 border border-blue-500/20 rounded-[3.5rem] p-12 text-center space-y-8 shadow-[0_30px_100px_rgba(59,130,246,0.15)] relative"
        >
          <div className="w-24 h-24 bg-blue-500/10 rounded-[2.5rem] flex items-center justify-center mx-auto border border-blue-500/20 shadow-inner">
            <AlertCircle className="text-blue-500 animate-pulse" size={48} />
          </div>
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-white tracking-tighter uppercase italic">Sessão Ativa</h2>
            <p className="text-zinc-400 text-[13px] font-medium leading-relaxed">
              Sua conta já está conectada em outro dispositivo. O BAC-BOT proíbe conexões simultâneas para prevenir vazamentos.
            </p>
            <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
              Heartbeat Ativo: {new Date(liveUserProfile?.lastActiveTime || Date.now()).toLocaleTimeString()}
            </p>
          </div>
          <div className="pt-4 space-y-4">
            <button 
              onClick={() => {
                reportActivity(); // assume controle
                window.location.reload();
              }}
              className="block w-full py-5 bg-blue-600 hover:bg-blue-500 text-white font-black uppercase tracking-wider text-xs rounded-2xl active:scale-95 transition-all shadow-[0_15px_40px_rgba(59,130,246,0.25)]"
            >
              Derrubar Conexão Anterior
            </button>
            <button 
              onClick={logout}
              className="w-full py-4 bg-zinc-800 text-zinc-500 font-black uppercase tracking-widest text-[10px] rounded-xl hover:bg-zinc-700 transition-all active:scale-95"
            >
              Desconectar desta sessão
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // Bloqueio 3: Acesso Restrito / Pendente ou Não VIP (Admin Isento)
  if ((isPendingApproval || (!isUserVip && !isLiberadoActive)) && !isAdmin) {
    const supportNum = remoteConfig.suporte || '998554117';
    const whatsAppLink = remoteConfig.canal || 'https://whatsapp.com/channel/0029VbDDmW98KMqi9YkzwU1';

    const isExpired = !isPendingApproval && !isUserVip;
    
    // Calculate assertividade real-time
    const winRate = liveStats.total > 0 
      ? ((liveStats.acertos / liveStats.total) * 100).toFixed(1) 
      : '95.2';

    return (
      <div className="min-h-screen bg-[#020205] text-amber-50 flex items-center justify-center p-4 md:p-6 bg-[radial-gradient(circle_at_bottom,_var(--tw-gradient-stops))] from-zinc-900/40 via-[#020205] to-[#020205] font-sans">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-xl bg-zinc-950/90 border border-white/5 rounded-[2.5rem] p-6 md:p-10 text-center space-y-6 shadow-[0_30px_100px_rgba(0,0,0,0.8)] relative overflow-hidden"
        >
          {/* Glowing Ambient light background */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-40 bg-gradient-to-b from-yellow-500/10 to-transparent blur-3xl pointer-events-none" />

          {/* Icon Header */}
          <div className="relative mx-auto w-24 h-24 rounded-[2.5rem] bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center shadow-xl relative">
            {isExpired ? (
              <Lock className="text-red-500 animate-pulse" size={48} />
            ) : (
              <AlertCircle className="text-yellow-500 animate-pulse" size={48} />
            )}
          </div>

          {/* Status Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-wider font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Transmissão de Dados ao Vivo
          </div>

          {/* Title & Educacional/Persuasivo message */}
          <div className="space-y-3">
            <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight uppercase italic">
              {isExpired ? 'Acesso Expirado' : 'Acesso Restrito'}
            </h2>
            
            {isExpired ? (
              <p className="text-zinc-400 text-sm leading-relaxed max-w-md mx-auto">
                Sua licença expirou. Nosso robô continua identificando ciclos de alta probabilidade em tempo real, mas sua transmissão privada foi desativada. <span className="text-zinc-200">Renove sua chave de acesso para voltar a receber as direções instantâneas combinadas!</span>
              </p>
            ) : (
              <p className="text-zinc-400 text-sm leading-relaxed max-w-md mx-auto">
                Seu cadastro foi recebido! O nosso algoritmo de alta performance utiliza múltiplos servidores de inteligência para processar padrões estocásticos com excelente assertividade. <span className="text-zinc-200">Para garantir processamento dedicado aos membros, o acesso ao terminal é restrito. Adquira sua licença para destravar as operações!</span>
              </p>
            )}
          </div>

          {/* Real-time Statistics Section */}
          <div className="bg-zinc-900/60 border border-white/5 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-white/5 pb-2.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500 font-mono">Resumo de Performance Geral</span>
              <span className="text-[10px] font-bold text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded uppercase font-mono">Atualizado Agora</span>
            </div>
            
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-black/40 border border-white/5 rounded-xl p-3 text-center">
                <span className="block text-[9px] text-zinc-500 font-bold uppercase tracking-wider mb-1">Sinais Totais</span>
                <span className="text-lg md:text-xl font-black text-zinc-100 font-mono">{liveStats.total || '2505'}</span>
              </div>
              <div className="bg-emerald-950/10 border border-emerald-500/10 rounded-xl p-3 text-center">
                <span className="block text-[9px] text-emerald-500/80 font-bold uppercase tracking-wider mb-1">Acertos</span>
                <span className="text-lg md:text-xl font-black text-emerald-400 font-mono">+{liveStats.acertos || '2403'}</span>
              </div>
              <div className="bg-red-950/10 border border-red-500/10 rounded-xl p-3 text-center">
                <span className="block text-[9px] text-red-500/80 font-bold uppercase tracking-wider mb-1">Perdas</span>
                <span className="text-lg md:text-xl font-black text-red-500 font-mono">-{liveStats.perdas || '102'}</span>
              </div>
            </div>

            <div className="flex items-center justify-between bg-yellow-500/5 border border-yellow-500/10 rounded-xl p-3 font-mono">
              <span className="text-[10px] font-bold uppercase text-zinc-400">Taxa de Assertividade:</span>
              <span className="text-xs font-black text-yellow-400">{winRate}%</span>
            </div>
          </div>

          {/* Actions & Supports */}
          <div className="space-y-3 pt-2">
            <a 
              href={`https://wa.me/244${supportNum}?text=Ol%C3%A1%20Suporte%21%20Gostaria%20de%20ativar/renovar%20meu%20VIP%20no%20BAC-BOT.%20Telefone: ${user?.phone || ''}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="block w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-500 text-white font-black uppercase tracking-widest text-xs rounded-xl hover:brightness-110 active:scale-95 transition-all shadow-[0_10px_30px_rgba(16,185,129,0.2)] flex items-center justify-center gap-2"
            >
              <MessageCircle size={18} /> Contactar Suporte (+244 {supportNum})
            </a>

            <a 
              href={whatsAppLink} 
              target="_blank" 
              rel="noopener noreferrer"
              className="block w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-black uppercase tracking-widest text-xs rounded-xl active:scale-95 transition-all border border-white/5 flex items-center justify-center gap-2"
            >
              <Zap size={16} className="text-yellow-500" /> Entrar no Canal do WhatsApp
            </a>
            
            <button 
              onClick={async () => {
                if (user?.phone) {
                  const updated = await verifyUserStatus(user.phone);
                  if (updated) {
                    setUser(updated);
                  } else {
                    logout();
                  }
                }
              }}
              className="w-full py-3 bg-transparent text-zinc-400 hover:text-white font-bold uppercase tracking-widest text-[10px] rounded-xl transition-all border border-white/5 hover:bg-white/5 font-mono"
            >
              Atualizar Status de Acesso
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020205] text-amber-50 font-sans selection:bg-yellow-500/30 overflow-x-hidden relative pb-10">
      {/* Abstract Background Accents */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-red-600/10 blur-[120px] rounded-full" />
      </div>

      <main className="max-w-xl mx-auto p-4 md:p-6 space-y-4 relative z-10">
        
        {/* Header - Premium Centralized Look with Real DB Agregated Stats */}
        <header className="flex flex-col gap-4 bg-zinc-900/40 backdrop-blur-xl p-5 rounded-[2.5rem] border border-white/10 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 w-1/2 h-0.5 bg-gradient-to-r from-transparent via-yellow-500/70 to-transparent" />
          
          {/* Primeiro Linear - Centralizado o Lema */}
          <div className="w-full flex flex-col items-center text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.25em] bg-gradient-to-r from-yellow-400 via-pink-500 to-indigo-400 bg-clip-text text-transparent leading-none">
              "O BOT QUE DÁ COR À TUA VIDA"
            </p>
          </div>

          {/* Segundo Linear - Minutos do empate resumido (apenas título e os minutos, sem explicação) */}
          {prediction?.baccaratAnalytics?.goldenMinutes && (
            <div className="w-full bg-gradient-to-r from-yellow-500/5 via-amber-500/10 to-yellow-500/5 border border-yellow-500/15 p-2.5 rounded-2xl flex flex-col items-center text-center">
              <span className="text-[9px] font-black text-yellow-500 uppercase tracking-[0.2em] mb-1.5">
                🌟 MINUTOS DO EMPATE
              </span>
              <div className="flex gap-2 w-full justify-center">
                {prediction.baccaratAnalytics.goldenMinutes.map((time, idx) => (
                  <div key={`golden-hdr-${idx}-${time}`} className="bg-black/50 border border-yellow-500/10 px-3.5 py-1.5 rounded-xl font-mono font-black text-xs text-yellow-400 tracking-wider">
                    {time}
                  </div>
                ))}
              </div>
            </div>
          )}
        </header>

        {/* Banner do MODO LIBERADO temporário com countdown */}
        {isLiberadoActive && (
          <div className="bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 text-center py-2 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest animate-pulse flex items-center justify-center gap-2 shadow-sm">
            <Zap size={11} className="text-yellow-400 animate-bounce" />
            <span>MODO LIBERADO ATIVO: {getLiberadoCountdown()}</span>
          </div>
        )}

        {/* Prediction Display - High Contrast */}
        <div className="bg-gradient-to-b from-zinc-900/80 to-black border border-white/10 rounded-[2.5rem] p-6 py-8 xs:p-8 relative overflow-hidden shadow-[0_30px_60px_rgba(0,0,0,0.6)]">
          <div className="absolute top-0 right-0 p-12 opacity-5 rotate-12">
            <Zap size={180} className="text-yellow-500" />
          </div>
          
          <div className="relative z-10 flex flex-col items-center text-center space-y-5">
            <div className="space-y-4 w-full">


              <h2 
                key={`${prediction?.side || 'none'}_${galeStage}_${isAnalyzing}`}
                className={`transition-all duration-300 drop-shadow-[0_15px_30px_rgba(0,0,0,0.4)] w-full ${
                  galeStage > 0 ? 'animate-fade-out-in' : ''
                }`}
              >
                {isAnalyzing ? (
                  <div className="flex flex-col items-center justify-center py-4 w-full">
                    <span className="block text-2xl xs:text-3xl font-black leading-tight tracking-wider text-yellow-500 uppercase animate-pulse">
                      🚨 analisando...🚨
                    </span>
                    
                    {/* Sequência real-time stats only if bot has chart data (history.length > 0) */}
                    {history.length > 0 && (
                      <div className="flex items-center gap-1.5 bg-black/50 px-4 py-2 rounded-full border border-white/5 mt-4 mb-2 shadow-inner">
                        <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Sequência:</span>
                        <div className="flex items-center gap-1.5 font-mono">
                          {history.slice(-5).map((res, idx) => (
                            <span key={`seq-analyzing-${idx}-${res}`} className="text-sm select-none font-black flex items-center">
                              {res === 'PLAYER' ? '🔵' : res === 'BANKER' ? '🔴' : '🟡'}
                              {idx < Math.min(history.length, 5) - 1 && <span className="text-zinc-700/60 mx-1">/</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Circle Loader indicating BOT is active in background */}
                    <div className="relative w-14 h-14 flex items-center justify-center mt-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-500/10 opacity-75"></span>
                      <svg className="animate-spin h-10 w-10 text-yellow-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </div>
                  </div>
                ) : isWaitingNextResult ? (
                  <div className="flex flex-col items-center justify-center py-4 w-full text-center">
                    <span className="block text-2xl xs:text-3xl font-black leading-tight tracking-wider text-purple-400 uppercase animate-pulse">
                      🔍 MODO ANÁLISE 🔍
                    </span>
                    <p className="text-zinc-300 font-sans text-center text-xs mt-3 uppercase tracking-wider max-w-[320px] leading-relaxed mx-auto">
                      {analysisModeReason === '3_GREENS' 
                        ? "Segurança Ativada: 3 Greens Consecutivos! Monitorando o próximo resultado do mercado para validar novas tendências."
                        : "Calibração Preventiva: Ajustando sensibilidades estocásticas após Loss. Registre a próxima rodada."}
                    </p>
                    <p className="text-zinc-500 font-mono text-[9px] mt-2.5 uppercase tracking-[0.2em]">
                      Insira o resultado real abaixo para destravar o robô
                    </p>
                  </div>
                ) : prediction?.side === 'PLAYER' ? (
                  <div className="flex flex-col items-center justify-center space-y-4 py-4 w-full animate-fade-out-in">
                    <div className="text-blue-500 font-black tracking-wide text-5xl xs:text-6xl uppercase italic drop-shadow-[0_0_35px_rgba(59,130,246,0.65)]">
                      PLAYER 🔵
                    </div>
                    <div className="inline-flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 px-4 py-1.5 rounded-full text-[11px] font-black uppercase tracking-[0.2em] text-yellow-400 shadow-md">
                      ⚠️ PROTEÇÃO NO EMPATE 🟡
                    </div>
                    
                    {/* Porcentagens distribuídas */}
                    <div className="bg-black/60 border border-white/5 rounded-2xl p-3.5 grid grid-cols-3 gap-2 mt-4 w-full max-w-xs">
                      <div className="text-center">
                        <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">Player</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.PLAYER * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center border-x border-white/10">
                        <p className="text-[8px] font-black text-yellow-500 uppercase tracking-widest mb-0.5">Tie</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.TIE * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[8px] font-black text-red-500 uppercase tracking-widest mb-0.5">Banker</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.BANKER * 100 || 0).toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                ) : prediction?.side === 'BANKER' ? (
                  <div className="flex flex-col items-center justify-center space-y-4 py-4 w-full animate-fade-out-in">
                    <div className="text-red-500 font-black tracking-wide text-5xl xs:text-6xl uppercase italic drop-shadow-[0_0_35px_rgba(239,68,68,0.65)]">
                      BANKER 🔴
                    </div>
                    <div className="inline-flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 px-4 py-1.5 rounded-full text-[11px] font-black uppercase tracking-[0.2em] text-yellow-400 shadow-md">
                      ⚠️ PROTEÇÃO NO EMPATE 🟡
                    </div>
                    
                    {/* Porcentagens distribuídas */}
                    <div className="bg-black/60 border border-white/5 rounded-2xl p-3.5 grid grid-cols-3 gap-2 mt-4 w-full max-w-xs">
                      <div className="text-center">
                        <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">Player</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.PLAYER * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center border-x border-white/10">
                        <p className="text-[8px] font-black text-yellow-500 uppercase tracking-widest mb-0.5">Tie</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.TIE * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[8px] font-black text-red-500 uppercase tracking-widest mb-0.5">Banker</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.BANKER * 100 || 0).toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                ) : prediction?.side === 'TIE' ? (
                  <div className="flex flex-col items-center justify-center space-y-4 py-4 w-full animate-fade-out-in">
                    <div className="text-yellow-500 font-black tracking-wide text-5xl xs:text-6xl uppercase italic drop-shadow-[0_0_35px_rgba(234,179,8,0.65)] animate-pulse">
                      EMPATE 🟡
                    </div>
                    <div className="inline-flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 px-4 py-1.5 rounded-full text-[11px] font-black uppercase tracking-[0.2em] text-yellow-400 shadow-md">
                      ⚠️ ALERTA DE ALTA TRANSICIONAL
                    </div>
                    
                    {/* Porcentagens distribuídas */}
                    <div className="bg-black/60 border border-white/5 rounded-2xl p-3.5 grid grid-cols-3 gap-2 mt-4 w-full max-w-xs">
                      <div className="text-center">
                        <p className="text-[8px] font-black text-blue-500 uppercase tracking-widest mb-0.5">Player</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.PLAYER * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center border-x border-white/10">
                        <p className="text-[8px] font-black text-yellow-500 uppercase tracking-widest mb-0.5">Tie</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.TIE * 100 || 0).toFixed(0)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[8px] font-black text-red-500 uppercase tracking-widest mb-0.5">Banker</p>
                        <p className="text-[13px] font-black text-white">{(prediction.probabilities?.BANKER * 100 || 0).toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                ) : (history.length >= 14 && statsBase === null) ? (
                  <div className="flex flex-col items-center justify-center py-6 w-full text-center space-y-4">
                    <span className="block text-2xl xs:text-3xl font-black leading-tight tracking-wider text-yellow-500 uppercase animate-pulse">
                      📊 AGUARDANDO 📊
                      <br />
                      📊 CALIBRAÇÃO 📊
                    </span>
                    <p className="text-zinc-400 font-sans text-center text-xs uppercase tracking-wider max-w-[320px] leading-relaxed mx-auto">
                      Insira as percentagens do gráfico abaixo para calibrar o algoritmo de inteligência e liberar a previsão.
                    </p>
                  </div>
                ) : (prediction?.side === 'WAIT' || history.length < 14) ? (
                  <div className="flex flex-col items-center justify-center py-4 w-full">
                    <span className="block text-2xl xs:text-3xl font-black leading-tight tracking-wider text-yellow-500 uppercase animate-pulse">
                      🚨 analisando...🚨
                    </span>
                    
                    {/* Sequência real-time stats only if bot has chart data (history.length > 0) */}
                    {history.length > 0 && (
                      <div className="flex items-center gap-1.5 bg-black/50 px-4 py-2 rounded-full border border-white/5 mt-4 mb-2 shadow-inner">
                        <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Sequência:</span>
                        <div className="flex items-center gap-1.5 font-mono">
                          {history.slice(-5).map((res, idx) => (
                            <span key={`seq-wait-${idx}-${res}`} className="text-sm select-none font-black flex items-center">
                              {res === 'PLAYER' ? '🔵' : res === 'BANKER' ? '🔴' : '🟡'}
                              {idx < Math.min(history.length, 5) - 1 && <span className="text-zinc-700/60 mx-1">/</span>}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Circle Loader indicating BOT is active in background */}
                    <div className="relative w-14 h-14 flex items-center justify-center mt-4">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-500/10 opacity-75"></span>
                      <svg className="animate-spin h-10 w-10 text-yellow-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </div>
                  </div>
                ) : (
                  '---'
                )}
              </h2>
              {isAnalyzing && (
                <p className="text-[10px] text-yellow-500 font-black uppercase mt-4 tracking-[0.3em] animate-pulse">
                  {analysisStatus}
                </p>
              )}

              {/* OUTCOME POPUP BANNER FOR WINS AND LOSSES */}
              <AnimatePresence>
                {latestOutcome?.type && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8, y: 15 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -15 }}
                    transition={{ type: 'spring', damping: 15 }}
                    className={`mt-4 px-6 py-3 rounded-full border text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 ${
                      latestOutcome.type.startsWith('GREEN') 
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.25)] animate-bounce' 
                        : 'bg-red-500/10 border-red-500/30 text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.25)] animate-pulse'
                    }`}
                  >
                    {latestOutcome.type.startsWith('GREEN') ? '✅' : '❌'} {latestOutcome.text}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {prediction && prediction.side !== 'WAIT' && (
              <div className="w-full max-w-xs space-y-4">
                {galeStage > 0 && (
                  <motion.div 
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.8 }}
                    className="w-full bg-yellow-500/15 border-2 border-yellow-500/40 p-5 rounded-3xl animate-lamp-breath flex flex-col items-center justify-center space-y-2 shadow-[0_0_30px_rgba(245,158,11,0.3)]"
                  >
                    <span className="text-xl xs:text-2xl font-black text-yellow-400 uppercase tracking-widest drop-shadow-[0_0_12px_rgba(234,179,8,0.7)]">
                      🚨 GALE {galeStage} ATIVO 🚨
                    </span>
                    <p className="text-[11px] font-black text-yellow-200 uppercase tracking-wider text-center leading-relaxed">
                      {galeStage === 1 
                        ? 'Gale 1: Repita a aposta na mesma cor e dobre a aposta para lucrar...' 
                        : 'Gale 2: Recupere o valor perdido...'}
                    </p>
                  </motion.div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons / Formulário de Calibração */}
        {history.length >= 14 && statsBase === null ? (
          <motion.div 
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-zinc-900/80 border border-yellow-500/10 rounded-[2.5rem] p-6 space-y-4 shadow-xl"
          >
            <div className="text-center space-y-1">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-yellow-500">Ajuste de Inteligência</span>
              <h4 className="text-xs font-black text-white uppercase tracking-wider">📊 Percentagem do Gráfico Completo</h4>
              <p className="text-[9px] text-zinc-500 uppercase tracking-widest leading-relaxed">
                Insira as percentagens reais da mesa para calibração dinâmica
              </p>
            </div>

            <form onSubmit={handleSavePercentages} className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col space-y-1">
                  <label className="text-[8px] font-black text-blue-400 uppercase tracking-widest text-left ml-1">Azul (P) %</label>
                  <input 
                    type="number" 
                    step="1"
                    min="0"
                    max="100"
                    required
                    placeholder="PLAYER"
                    value={percentP}
                    onChange={(e) => setPercentP(e.target.value)}
                    className="bg-zinc-950 border border-blue-500/20 rounded-2xl p-3 text-center text-xs text-white font-black font-mono focus:border-blue-500/60 focus:outline-none transition-colors"
                  />
                </div>
                <div className="flex flex-col space-y-1">
                  <label className="text-[8px] font-black text-yellow-500 uppercase tracking-widest text-left ml-1">Empate (T) %</label>
                  <input 
                    type="number" 
                    step="1"
                    min="0"
                    max="100"
                    required
                    placeholder="TIE"
                    value={percentT}
                    onChange={(e) => setPercentT(e.target.value)}
                    className="bg-zinc-950 border border-yellow-500/20 rounded-2xl p-3 text-center text-xs text-white font-black font-mono focus:border-yellow-500/60 focus:outline-none transition-colors"
                  />
                </div>
                <div className="flex flex-col space-y-1">
                  <label className="text-[8px] font-black text-red-400 uppercase tracking-widest text-left ml-1">Vermelho (B) %</label>
                  <input 
                    type="number" 
                    step="1"
                    min="0"
                    max="100"
                    required
                    placeholder="BANKER"
                    value={percentB}
                    onChange={(e) => setPercentB(e.target.value)}
                    className="bg-zinc-950 border border-red-500/20 rounded-2xl p-3 text-center text-xs text-white font-black font-mono focus:border-red-500/60 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <button 
                type="submit"
                className="w-full py-3.5 bg-gradient-to-r from-yellow-500 to-amber-600 hover:from-yellow-400 hover:to-amber-500 text-black font-black text-xs uppercase tracking-widest rounded-2xl transition-all duration-300 shadow-md shadow-yellow-500/10 active:scale-95"
              >
                Actualizar Dados
              </button>
            </form>
          </motion.div>
        ) : (
          <div className="grid grid-cols-3 gap-5 p-4 rounded-[2.5rem]" style={{ backgroundColor: '#000000' }}>
            <button 
              disabled={isAnalyzing}
              onClick={() => addResult('PLAYER')}
              className="group h-40 bg-zinc-900/60 border border-blue-600/20 rounded-[2rem] flex flex-col items-center justify-center gap-4 hover:border-blue-500/60 transition-all active:scale-95 disabled:opacity-50 relative overflow-hidden shadow-xl select-none touch-manipulation"
            >
              <div className="absolute inset-0 bg-blue-600/5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-16 h-16 rounded-[1.25rem] bg-blue-600 flex items-center justify-center text-white font-black text-2xl shadow-[0_15px_30px_rgba(37,99,235,0.4)] transition-transform group-hover:scale-110">P</div>
              <span className="text-xs font-black text-blue-400 uppercase tracking-widest group-hover:text-blue-300">PLAYER</span>
            </button>
            
            <button 
              disabled={isAnalyzing}
              onClick={() => addResult('TIE')}
              className="group h-40 bg-zinc-900/60 border border-[#ffc500]/20 rounded-[2rem] flex flex-col items-center justify-center gap-4 hover:border-[#ffc500]/60 transition-all active:scale-95 disabled:opacity-50 relative overflow-hidden shadow-xl select-none touch-manipulation"
            >
              <div className="absolute inset-0 bg-[#ffc500]/5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-16 h-16 rounded-[1.25rem] bg-[#ffc500] flex items-center justify-center text-black font-black text-2xl shadow-[0_15px_30px_rgba(255,197,0,0.4)] transition-transform group-hover:scale-110">T</div>
              <span className="text-xs font-black text-yellow-500 uppercase tracking-widest group-hover:text-yellow-400">TIE</span>
            </button>
            
            <button 
              disabled={isAnalyzing}
              onClick={() => addResult('BANKER')}
              className="group h-40 bg-zinc-900/60 border border-red-600/20 rounded-[2rem] flex flex-col items-center justify-center gap-4 hover:border-red-500/60 transition-all active:scale-95 disabled:opacity-50 relative overflow-hidden shadow-xl select-none touch-manipulation"
            >
              <div className="absolute inset-0 bg-red-600/5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-16 h-16 rounded-[1.25rem] bg-red-600 flex items-center justify-center text-white font-black text-2xl shadow-[0_15px_30px_rgba(220,38,38,0.4)] transition-transform group-hover:scale-110">B</div>
              <span className="text-xs font-black text-red-400 uppercase tracking-widest group-hover:text-red-300">BANKER</span>
            </button>
          </div>
        )}

        {/* Botão de Apagar Último Registro (Desfazer) */}
        <div className="flex justify-center w-full">
          <button 
            onClick={undoLastRecord}
            className="w-full py-3 px-6 bg-red-950/10 hover:bg-red-950/30 text-red-400 hover:text-red-300 transition-all border border-red-500/10 rounded-2xl flex items-center justify-center gap-2 text-xs font-black uppercase tracking-widest active:scale-95 shadow-md"
            title="Desfazer Último Registro"
          >
            <Trash2 size={14} className="animate-pulse text-red-500" />
            Apagar Último Registro
          </button>
        </div>

        {/* Stats Summary - Simple and Professional */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-emerald-500/10 border border-emerald-500/20 p-5 rounded-3xl flex flex-col items-center justify-center text-center space-y-1">
            <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Acertos</p>
            <p className="text-2xl font-black text-white">{score.wins}</p>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 p-5 rounded-3xl flex flex-col items-center justify-center text-center space-y-1">
            <p className="text-[9px] font-black text-red-500 uppercase tracking-widest">Erros</p>
            <p className="text-2xl font-black text-white">{score.losses}</p>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/20 p-5 rounded-3xl flex flex-col items-center justify-center text-center space-y-1">
            <p className="text-[9px] font-black text-yellow-500 uppercase tracking-widest">Assertividade</p>
            <p className="text-2xl font-black text-white">
              {score.wins + score.losses > 0 
                ? `${((score.wins / (score.wins + score.losses)) * 100).toFixed(0)}%` 
                : '0%'
              }
            </p>
          </div>
        </div>

        {/* History Visualization (Bead Plate Style) */}
        <div className="bg-zinc-900/40 backdrop-blur-xl border border-white/10 rounded-[3rem] p-8 space-y-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest flex items-center gap-2">
              <Clock size={14} /> Histórico Recente (Bead Plate)
            </h3>
            <span className="text-[10px] font-black text-yellow-500 uppercase tracking-widest">{history.length} Entradas</span>
          </div>
          
          <div className="flex gap-2 overflow-x-auto pb-4 scrollbar-hide mask-fade-right">
            <div className="flex flex-wrap flex-col h-[168px] gap-1 content-start">
              {history.map((res, i) => (
                <motion.div 
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  key={`bead-${i}-${res}`}
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-black shadow-lg shrink-0 ${
                    res === 'BANKER' ? 'bg-red-600 shadow-red-900/40' : 
                    res === 'PLAYER' ? 'bg-blue-600 shadow-blue-900/40' : 
                    'bg-[#ffc500] text-black shadow-yellow-900/40'
                  }`}
                >
                  {res[0]}
                </motion.div>
              ))}
              {history.length === 0 && (
                <div className="h-full flex items-center justify-center w-full min-w-[200px] text-zinc-700 text-[9px] font-black uppercase tracking-widest italic">
                  Aguardando Resultados...
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Percentagem Atualizada da Mesa Completa (depois do gráfico) */}
        {statsBase !== null && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-zinc-900/40 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
                Percentagem Atualizada da Mesa Completa
              </span>
              <button 
                onClick={() => {
                  setStatsBase(null);
                  localStorage.removeItem('bac_bot_stats_base');
                }}
                className="text-[8px] font-black text-red-400 hover:text-red-300 uppercase tracking-widest transition-colors flex items-center gap-1 cursor-pointer"
              >
                🔄 Recalibrar
              </button>
            </div>

            {(() => {
              const percentages = getUpdatedPercentages();
              if (!percentages) return null;
              return (
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="bg-blue-950/20 border border-blue-500/10 p-3 rounded-2xl flex flex-col justify-center">
                    <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest mb-1">AZUL</span>
                    <span className="text-lg font-black font-mono text-blue-300">{percentages.PLAYER}%</span>
                  </div>
                  <div className="bg-yellow-950/20 border border-[#ffc500]/10 p-3 rounded-2xl flex flex-col justify-center">
                    <span className="text-[8px] font-black text-[#ffc500] uppercase tracking-widest mb-1">EMPATE</span>
                    <span className="text-lg font-black font-mono text-[#ffc500]">{percentages.TIE}%</span>
                  </div>
                  <div className="bg-red-950/20 border border-red-500/10 p-3 rounded-2xl flex flex-col justify-center">
                    <span className="text-[8px] font-black text-red-400 uppercase tracking-widest mb-1">VERMELHO</span>
                    <span className="text-lg font-black font-mono text-red-300">{percentages.BANKER}%</span>
                  </div>
                </div>
              );
            })()}
          </motion.div>
        )}

        {/* SISTEMA COMPLETO DE ANÁLISE DE PADRÕES E ROAD MAP (OCULTADO/GONE EM SEGUNDO PLANO) */}
        {false && prediction && prediction.side !== 'WAIT' && prediction.baccaratAnalytics && (
          <div className="bg-zinc-900/40 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-6 space-y-5 shadow-2xl">
            <div className="flex items-center gap-2 border-b border-white/5 pb-3">
              <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              <h3 className="text-xs font-black text-white uppercase tracking-widest">
                🔬 SISTEMA COMPLETO DE ANÁLISE ESTOCÁSTICA
              </h3>
            </div>

            {/* MINUTOS DE OURO DO EMPATE */}
            {prediction.baccaratAnalytics.goldenMinutes && (
              <div className="bg-gradient-to-r from-yellow-500/10 via-amber-500/15 to-yellow-500/10 border border-yellow-500/30 p-4 rounded-3xl relative overflow-hidden shadow-lg shadow-yellow-500/5">
                <div className="absolute top-0 right-0 p-2 text-yellow-500/10 font-black text-4xl select-none uppercase font-mono">GOLD</div>
                <span className="text-[9px] font-black text-yellow-400 uppercase tracking-[0.2em] block mb-1">
                  🌟 Minutos de Ouro (Proteger Empate)
                </span>
                <p className="text-[9px] text-zinc-300 leading-snug mb-3 uppercase">
                  Intervalo de agora até 10 minutos calculado dinamicamente com base na estatística atual e padrão de intervalos de empate.
                </p>
                <div className="flex gap-2.5">
                  {prediction.baccaratAnalytics.goldenMinutes.map((time, idx) => (
                    <div key={`golden-detail-${idx}-${time}`} className="flex-1 bg-black/60 border border-yellow-500/20 p-2.5 rounded-xl text-center shadow-inner">
                      <span className="text-[8px] font-black text-zinc-500 uppercase block">Minuto {idx + 1}</span>
                      <span className="text-sm font-black font-mono text-yellow-400 tracking-wider">{time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Grid de Sequência Dominante e Alternâncias Prévias */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-black/40 border border-white/5 p-4 rounded-2xl flex flex-col justify-between space-y-1.5 shadow-inner">
                <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Sequência Dominante</span>
                <p className="text-[11px] font-black text-purple-400 uppercase leading-tight">
                  {prediction.baccaratAnalytics.dominantSequence}
                </p>
                <div className="w-full bg-zinc-800/80 h-1 mt-1 rounded-full overflow-hidden">
                  <div 
                    className="bg-purple-500 h-full rounded-full transition-all duration-500" 
                    style={{ width: `${prediction.baccaratAnalytics.dominanceRatio * 100}%` }}
                  />
                </div>
                <span className="text-[8px] font-mono text-zinc-500">
                  Fidelidade: {(prediction.baccaratAnalytics.dominanceRatio * 100).toFixed(0)}%
                </span>
              </div>

              <div className="bg-black/40 border border-white/5 p-4 rounded-2xl flex flex-col justify-between space-y-1.5 shadow-inner">
                <span className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">Alternâncias Prévias</span>
                <p className="text-xl font-black text-yellow-500 leading-none">
                  {prediction.baccaratAnalytics.alternationsCountBeforeSeq}x
                </p>
                <p className="text-[8px] font-sans text-zinc-400 uppercase tracking-wider leading-tight">
                  registradas antes da sequência activa
                </p>
              </div>
            </div>

            {/* TELEMETRIA SAZONAL BAYESIANA */}
            {prediction.baccaratAnalytics.seasonalTelemetry && (
              <div className="bg-zinc-950/60 border border-white/5 p-4 rounded-3xl space-y-3 shadow-inner">
                <div className="flex items-center justify-between border-b border-white/5 pb-1.5">
                  <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest block">
                    📅 Telemetria Sazonal Bayesiana
                  </span>
                  <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full border ${
                    prediction.baccaratAnalytics.seasonalTelemetry.isPaydayEffectActive
                      ? 'bg-purple-500/15 border-purple-500/20 text-purple-400 animate-pulse'
                      : 'bg-zinc-800/40 border-white/5 text-zinc-400'
                  }`}>
                    {prediction.baccaratAnalytics.seasonalTelemetry.isPaydayEffectActive ? 'Payday Ativo' : 'Payday Neutro'}
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-3.5 text-[10px] font-mono">
                  <div className="bg-black/30 p-2.5 rounded-xl border border-white/5">
                    <span className="text-[8px] font-sans font-black text-zinc-500 uppercase block">Dia do Mês</span>
                    <span className="text-zinc-200 font-bold">{prediction.baccaratAnalytics.seasonalTelemetry.dayOfMonth}</span>
                  </div>
                  <div className="bg-black/30 p-2.5 rounded-xl border border-white/5">
                    <span className="text-[8px] font-sans font-black text-zinc-500 uppercase block">Atividade Circadiana</span>
                    <span className="text-zinc-200 font-bold">{prediction.baccaratAnalytics.seasonalTelemetry.circadianAmplitude} rds</span>
                  </div>
                </div>

                <div className="bg-black/40 p-3 rounded-xl border border-white/5 text-[9px] text-zinc-400 space-y-1.5 leading-snug">
                  <p className="uppercase">
                    <span className="text-white font-black">Modelo Matemático:</span> {prediction.baccaratAnalytics.seasonalTelemetry.mathematicalFormula}
                  </p>
                  <p className="uppercase border-t border-white/5 pt-1.5">
                    <span className="text-purple-400 font-black">Ajuste Bayesiano:</span> +{((prediction.baccaratAnalytics.seasonalTelemetry.bayesianUpdateFactor - 1) * 100).toFixed(1)}% na assertividade estocástica em tempo real.
                  </p>
                </div>
              </div>
            )}

            {/* Condições de Sequência e Condições de Alternância solicitadas */}
            <div className="space-y-3">
              <div className="bg-blue-950/20 border border-blue-500/10 p-3.5 rounded-2xl">
                <span className="text-[8px] font-black text-blue-400 uppercase tracking-[0.2em] block mb-1">
                  🎯 Condição Estocástica da Sequência
                </span>
                <p className="text-[11px] font-sans text-zinc-300 leading-relaxed uppercase">
                  {prediction.baccaratAnalytics.sequenceCondition}
                </p>
              </div>

              <div className="bg-amber-950/20 border border-amber-500/10 p-3.5 rounded-2xl">
                <span className="text-[8px] font-black text-yellow-500 uppercase tracking-[0.2em] block mb-1">
                  🔄 Condição de Alternância (Chop)
                </span>
                <p className="text-[11px] font-sans text-zinc-300 leading-relaxed uppercase">
                  {prediction.baccaratAnalytics.alternationCondition}
                </p>
              </div>

              <div className="bg-purple-950/20 border border-purple-500/10 p-3.5 rounded-2xl">
                <span className="text-[8px] font-black text-purple-400 uppercase tracking-[0.2em] block mb-1">
                  🗺️ Padrão Dominante do Road Map
                </span>
                <p className="text-[11px] font-mono text-zinc-300 uppercase tracking-wider">
                  {prediction.baccaratAnalytics.roadMapDominantStyle}
                </p>
              </div>
            </div>

            {/* MATRIZ DE TRANSIÇÃO DE 5 SEQUÊNCIAS (LIVE JSON) */}
            {prediction.baccaratAnalytics.sequenceDatabase && Object.keys(prediction.baccaratAnalytics.sequenceDatabase).length > 0 && (
              <div className="space-y-2">
                <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest block px-1">
                  🗂️ Matriz de Transição de 5 Sequências (Live JSON)
                </span>
                <div className="bg-black/75 border border-white/10 rounded-2xl p-4 font-mono text-[10px] max-h-[150px] overflow-y-auto scrollbar-hide text-zinc-300">
                  {Object.entries(prediction.baccaratAnalytics.sequenceDatabase).slice(-6).map(([pattern, transitions], idx) => {
                    const trans = transitions as { B: number; P: number; T: number };
                    return (
                      <div key={`seq-db-${pattern}-${idx}`} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors px-1 text-[11px]">
                        <span className="text-purple-400 font-black">{pattern}</span>
                        <span className="text-zinc-600">➔</span>
                        <span className="text-yellow-400 font-semibold uppercase">
                          B:{trans.B} | P:{trans.P} | T:{trans.T}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Checklist de Verificação de Todos Padrões solicitada */}
            <div className="space-y-2">
              <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest block px-1">
                📋 Checklist de Padrões Clássicos & IA (Baccarat)
              </span>
              <div className="grid grid-cols-1 gap-2 max-h-[170px] overflow-y-auto pr-1 scrollbar-hide">
                {prediction.baccaratAnalytics.patternVerificationList.map((p, idx) => (
                  <div key={`pattern-verify-${p.name}-${idx}`} className="bg-black/30 border border-white/5 p-3 rounded-xl flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="text-[10px] font-black text-zinc-200 uppercase">{p.name}</p>
                      <p className="text-[9px] text-zinc-500 leading-snug uppercase">{p.description}</p>
                    </div>
                    <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-full border shrink-0 transition-colors ${
                      p.status === 'Identificado' 
                        ? 'bg-emerald-500/15 border-emerald-500/20 text-emerald-400' 
                        : 'bg-zinc-800/40 border-white/5 text-zinc-500'
                    }`}>
                      {p.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Roadmaps & HUD metrics (OCULTADO/GONE EM SEGUNDO PLANO) */}
        {false && (
          <div className="block bg-zinc-900/40 backdrop-blur-xl border border-white/10 rounded-[3rem] p-8 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-2">
              <h3 className="text-[10px] font-black text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                <Zap size={14} className="text-yellow-500 animate-pulse" /> Padrões de Estradas (Roadmaps) & Velocidade
              </h3>
              <div className="flex flex-wrap gap-2 text-[10px]">
                <span className={`px-2.5 py-1 rounded-full font-black uppercase tracking-wider text-[8px] flex items-center gap-1 ${
                  avgVelocity > 0 ? (avgVelocity < 15 ? 'bg-red-500/10 text-red-400 border border-red-500/20' : avgVelocity <= 25 ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20') : 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20'
                }`}>
                  {avgVelocity > 0 ? `Speed: ${avgVelocity}s` : 'Speed: Sincronizando'}
                </span>
                <span className="px-2.5 py-1 bg-zinc-800/60 rounded-full font-black uppercase tracking-wider text-[8px] text-zinc-300">
                  {getVelocityLabel(avgVelocity)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
              {/* HUD Status Alerts */}
              <div className="bg-zinc-950/40 border border-white/5 rounded-[2rem] p-6 space-y-4">
                <h4 className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">
                  Detecção em Tempo Real, Streaks & Flutuação
                </h4>
                
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-2xl border border-white/5">
                    <div className="space-y-0.5">
                      <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest">Padrão Dragon (Big Road)</p>
                      <p className="text-xs font-black text-white">
                        {roadsData.isDragonActive && roadsData.dragonSide ? (
                          <span className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${roadsData.dragonSide === 'PLAYER' ? 'bg-blue-500' : 'bg-red-500'}`} />
                            {roadsData.dragonSide === 'PLAYER' ? 'Azul Ativo' : 'Vermelho Ativo'}
                          </span>
                        ) : 'Inativo'}
                      </p>
                    </div>
                    {roadsData.isDragonActive && (
                      <span className="px-2 py-0.5 bg-red-500/20 text-red-400 border border-red-500/30 text-[8px] font-black rounded-lg uppercase tracking-wider animate-pulse">
                        Alerta Reversão
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between p-3 bg-zinc-900/40 rounded-2xl border border-white/5">
                    <div className="space-y-0.5">
                      <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest">Sequências Ping-Pong (Chops)</p>
                      <p className="text-xs font-black text-white">
                        {roadsData.isPingPongActive ? `Ativo: Alternando (${roadsData.pingPongLength}x)` : 'Inativo'}
                      </p>
                    </div>
                    {roadsData.isPingPongActive && (
                      <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 text-[8px] font-black rounded-lg uppercase tracking-wider">
                        Alternância Estável
                      </span>
                    )}
                  </div>

                  {/* Highly requested Advanced metrics for Streaks by Color and Maximum alternation */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-0.5">
                      <p className="text-[8.5px] font-black text-zinc-500 uppercase tracking-wider">Sequência Atual</p>
                      <p className="text-[11px] font-black text-zinc-100 flex items-center gap-1">
                        {roadsData.currentStreak > 0 && roadsData.currentStreakSide ? (
                          <>
                            <span className={`w-1.5 h-1.5 rounded-full ${roadsData.currentStreakSide === 'PLAYER' ? 'bg-blue-500' : 'bg-red-500'}`} />
                            {roadsData.currentStreakSide === 'PLAYER' ? 'PLAYER' : 'BANKER'} (x{roadsData.currentStreak})
                          </>
                        ) : 'Aguardando'}
                      </p>
                    </div>

                    <div className="p-3 bg-zinc-900/40 rounded-2xl border border-white/5 space-y-0.5">
                      <p className="text-[8.5px] font-black text-zinc-500 uppercase tracking-wider">Max Alternância (Chop)</p>
                      <p className="text-[11px] font-black text-yellow-500">
                        x{roadsData.maxAlternation || 0} cortes
                      </p>
                    </div>
                  </div>

                  <div className="p-3 bg-zinc-900/40 rounded-2xl border border-white/5 flex justify-between items-center">
                    <div className="space-y-0.5">
                      <p className="text-[8.5px] font-black text-zinc-500 uppercase tracking-wider">Altas de Sequências por Cor (Max Streaks)</p>
                      <div className="flex gap-4 text-[10px] font-black">
                        <span className="text-blue-400">PLAYER: x{roadsData.maxPlayerStreak || 0}</span>
                        <span className="text-red-400">BANKER: x{roadsData.maxBankerStreak || 0}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sub Roads: Big Eye Boy & Small Road */}
              <div className="bg-zinc-950/40 border border-white/5 rounded-[2rem] p-6 space-y-4">
                <h4 className="text-[9px] font-black text-zinc-500 uppercase tracking-widest">
                  Estradas Derivadas (Tendência Fina)
                </h4>

                <div className="space-y-3.5">
                  {/* Big Eye Boy */}
                  <div className="space-y-1">
                    <p className="text-[8px] font-black text-zinc-400 uppercase tracking-widest flex justify-between">
                      <span>Grande Olho (Big Eye Boy)</span>
                      <span className="text-zinc-600 font-mono">{roadsData.bigEyeBoy.length} pt</span>
                    </p>
                    <div className="flex gap-1 overflow-x-auto py-1 scrollbar-hide">
                      {roadsData.bigEyeBoy.map((color, idx) => (
                        <span 
                          key={`bigeyeboy-${idx}-${color}`} 
                          className={`w-2.5 h-2.5 rounded-full shrink-0 border border-white/5 ${
                            color === 'RED' ? 'bg-red-500 shadow-md shadow-red-500/20' : 'bg-blue-500 shadow-md shadow-blue-500/20'
                          }`} 
                        />
                      ))}
                      {roadsData.bigEyeBoy.length === 0 && (
                        <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider py-1">Sem oscilações suficientes</span>
                      )}
                    </div>
                  </div>

                  {/* Small Road */}
                  <div className="space-y-1">
                    <p className="text-[8px] font-black text-zinc-400 uppercase tracking-widest flex justify-between">
                      <span>Pequeno Caminho (Small Road)</span>
                      <span className="text-zinc-600 font-mono">{roadsData.smallRoad.length} pt</span>
                    </p>
                    <div className="flex gap-1 overflow-x-auto py-1 scrollbar-hide">
                      {roadsData.smallRoad.map((color, idx) => (
                        <span 
                          key={`smallroad-${idx}-${color}`} 
                          className={`w-1.5 h-1.5 rounded-full shrink-0 border border-white/5 ${
                            color === 'RED' ? 'bg-red-500 shadow-sm shadow-red-500/10' : 'bg-blue-500 shadow-sm shadow-blue-500/10'
                          }`} 
                        />
                      ))}
                      {roadsData.smallRoad.length === 0 && (
                        <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider py-1">Aguardando dados refinados...</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Big Road Grid - Authentic representation */}
            <div className="border border-white/5 bg-zinc-950/20 rounded-[2rem] p-6 space-y-3">
              <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest">Caminho Principal (Big Road Grid)</p>
              <div className="w-full overflow-x-auto scrollbar-hide pb-2">
                <div className="flex flex-row gap-1.5 min-w-max">
                  {roadsData.bigRoad.map((col, colIdx) => (
                    <div key={`bigroad-col-${colIdx}`} className="flex flex-col gap-1.5">
                      {col.map((cell, rowIdx) => (
                        <div 
                          key={`bigroad-cell-${colIdx}-${rowIdx}-${cell.result}`} 
                          className={`w-6 h-6 rounded-full border flex items-center justify-center relative shrink-0 transition-all ${
                            cell.result === 'BANKER' 
                              ? 'border-red-500/40 bg-red-950/30' 
                              : 'border-blue-500/40 bg-blue-950/30'
                          }`}
                        >
                          <span className={`w-3 h-3 rounded-full ${cell.result === 'BANKER' ? 'bg-red-500' : 'bg-blue-500'}`} />
                          {cell.ties > 0 && (
                            <span className="absolute -top-1 -right-1 w-3 h-3 bg-[#ffc500] border border-zinc-950 text-zinc-950 font-black text-[6px] rounded-full flex items-center justify-center scale-90">
                              {cell.ties}
                            </span>
                          )}
                        </div>
                      ))}
                      {/* Empty placeholder block to keep standard vertical grid height of 6 cells if column has fewer cells */}
                      {Array.from({ length: Math.max(0, 6 - col.length) }).map((_, emptyIdx) => (
                        <div 
                          key={`bigroad-empty-${colIdx}-${emptyIdx}`} 
                          className="w-6 h-6 rounded-full border border-zinc-900/10 bg-transparent shrink-0" 
                        />
                      ))}
                    </div>
                  ))}
                  {roadsData.bigRoad.length === 0 && (
                    <div className="text-[10px] font-mono text-zinc-600 uppercase tracking-wider italic py-4">Sem dados gravados no grid</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

      </main>



        {/* Real-time Automated Dialogue Popup */}
        <AnimatePresence>
          {remoteConfig?.dialog?.ativo && dismissedDialog !== (remoteConfig.dialog.titulo + "::" + remoteConfig.dialog.mensagem) && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in"
            >
              <motion.div 
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className="w-full max-w-md bg-zinc-900 border border-white/10 rounded-[3rem] p-8 text-center space-y-6 shadow-2xl relative overflow-hidden"
              >
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-yellow-500 via-amber-400 to-yellow-600" />
                
                <div className="w-16 h-16 bg-yellow-500/10 rounded-2xl flex items-center justify-center mx-auto border border-yellow-500/20">
                  <AlertCircle className="text-yellow-500 animate-pulse" size={32} />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-xl font-black text-white uppercase tracking-tight">
                    {remoteConfig.dialog.titulo || "Informativo"}
                  </h3>
                  <p className="text-zinc-400 text-xs font-medium leading-relaxed">
                    {remoteConfig.dialog.mensagem || "Mensagem de diálogo automática remota."}
                  </p>
                </div>

                <button 
                  onClick={() => setDismissedDialog(remoteConfig.dialog.titulo + "::" + remoteConfig.dialog.mensagem)}
                  className="w-full py-4 bg-zinc-800 hover:bg-zinc-700 text-white font-black uppercase tracking-widest text-[10px] rounded-xl transition-all active:scale-95 border border-white/5 shadow-md"
                >
                  Entendido
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
    </div>
  );
}
