export type Result = 'PLAYER' | 'BANKER' | 'TIE';

export interface GameRound {
  id: string;
  result: Result;
  timestamp: number;
  playerDice: [number, number];
  bankerDice: [number, number];
  playerSum: number;
  bankerSum: number;
}

export interface Prediction {
  side: Result | 'WAIT';
  confidence: number;
  reasoning: string;
  probabilities: {
    PLAYER: number;
    BANKER: number;
    TIE: number;
  };
  layers: {
    variance: number;
    rpp: number;
    entropy: number;
  };
  galeViable?: {
    viable: boolean;
    reason: string;
  };
  nextScenarios?: {
    IF_PLAYER: Result | 'WAIT';
    IF_BANKER: Result | 'WAIT';
    IF_TIE: Result | 'WAIT';
  };
  temporalStats?: {
    avgVolumeHour: number;
    playerDominanceHour: number;
    bankerDominanceHour: number;
    isPeakHour: boolean;
    dealerShift: string;
    currentHour: number;
    currentDay: number;
  };
  baccaratAnalytics?: {
    dominantSequence: string;
    dominanceRatio: number;
    alternationsCountBeforeSeq: number;
    sequenceCondition: string;
    alternationCondition: string;
    roadMapDominantStyle: string;
    patternVerificationList: Array<{ name: string; status: string; description: string }>;
    sequenceDatabase?: Record<string, { B: number; P: number; T: number }>;
    goldenMinutes?: string[];
    seasonalTelemetry?: {
      dayOfMonth: number;
      isPaydayEffectActive: boolean;
      circadianAmplitude: number;
      isAbnormalVolume: boolean;
      bayesianUpdateFactor: number;
      mathematicalFormula: string;
    };
  };
}

export interface BankrollState {
  balance: number;
  initialBalance: number;
  unit: number;
  stopLoss: number;
  stopWin: number;
  currentSessionProfit: number;
}

export type StrategyType = 'FLAT' | 'MARTINGALE' | 'PAROLI' | '1-3-2-6' | 'LABOUCHERE';
