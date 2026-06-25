import { Result } from '../types';

export interface RoadCell {
  result: 'PLAYER' | 'BANKER';
  ties: number; // number of ties nested
}

export type RoadColumn = RoadCell[];

export interface RoadsData {
  bigRoad: RoadColumn[];
  bigEyeBoy: ('RED' | 'BLUE')[];
  smallRoad: ('RED' | 'BLUE')[];
  dragonCount: number; // Number of long active same-side streaks (> 5 rounds)
  pingPongLength: number; // Length of current active ping-pong alternation (e.g. 1-1-1-1 columns)
  isDragonActive: boolean;
  isPingPongActive: boolean;
  dragonSide: 'PLAYER' | 'BANKER' | null;
  currentAlternation: number;
  maxAlternation: number;
  maxPlayerStreak: number;
  maxBankerStreak: number;
  currentStreak: number;
  currentStreakSide: 'PLAYER' | 'BANKER' | null;
}

/**
 * Generates Baccarat/Bac Bo Road maps from historical outcomes
 */
export function calculateRoads(history: Result[]): RoadsData {
  // Filter out ties for structural road splits as standard in Baccarat
  const nonTies = history.filter((r): r is 'PLAYER' | 'BANKER' => r === 'PLAYER' || r === 'BANKER');
  
  // 1. Calculate Big Road
  const bigRoad: RoadColumn[] = [];
  let currentColumn: RoadColumn = [];
  
  // Also track matches with ties intact for exact Big Road drawing
  let tempCol: RoadColumn = [];
  let tieCount = 0;
  
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item === 'TIE') {
      tieCount++;
      // If we already have a node, we attach tie increment to it
      if (tempCol.length > 0) {
        tempCol[tempCol.length - 1].ties++;
      } else if (bigRoad.length > 0) {
        // Attach to the last node of the previous column if column is empty
        const lastCol = bigRoad[bigRoad.length - 1];
        if (lastCol.length > 0) {
          lastCol[lastCol.length - 1].ties++;
        }
      }
    } else {
      if (tempCol.length === 0) {
        tempCol.push({ result: item, ties: 0 });
      } else if (tempCol[0].result === item) {
        tempCol.push({ result: item, ties: 0 });
      } else {
        bigRoad.push(tempCol);
        tempCol = [{ result: item, ties: 0 }];
      }
    }
  }
  if (tempCol.length > 0) {
    bigRoad.push(tempCol);
  }

  // Generate reference-based pure Big Road (without ties) for derived roads
  const pureBigRoad: RoadColumn[] = [];
  let pCol: RoadColumn = [];
  for (const r of nonTies) {
    if (pCol.length === 0) {
      pCol.push({ result: r, ties: 0 });
    } else if (pCol[0].result === r) {
      pCol.push({ result: r, ties: 0 });
    } else {
      pureBigRoad.push(pCol);
      pCol = [{ result: r, ties: 0 }];
    }
  }
  if (pCol.length > 0) {
    pureBigRoad.push(pCol);
  }

  // 2. Derive Big Eye Boy (Compares current column to 1 column back)
  // Started from column 2 (0-indexed: index 1), row 2 (0-indexed: index 1). If column is new, compares previous column with 2 columns ago.
  const bigEyeBoy: ('RED' | 'BLUE')[] = [];
  
  // Helper to check Cell existence in pureBigRoad
  const hasCell = (colIdx: number, rowIdx: number): boolean => {
    return pureBigRoad[colIdx] !== undefined && pureBigRoad[colIdx][rowIdx] !== undefined;
  };

  // We start analyzing from the 2nd column of pureBigRoad, at row index 1 (the 2nd item)
  // or anytime a new column is started (index 0) from the 3rd column onwards.
  for (let c = 1; c < pureBigRoad.length; c++) {
    const colLength = pureBigRoad[c].length;
    const startRow = (c === 1) ? 1 : 0; // standard baccarat rule: skip first cell in column 2
    
    for (let r = startRow; r < colLength; r++) {
      if (r === 0) {
        // Comparing Column C-1 and Column C-2 length
        const lenPrev = pureBigRoad[c - 1].length;
        const lenPrevPrev = pureBigRoad[c - 2] ? pureBigRoad[c - 2].length : 0;
        if (lenPrev === lenPrevPrev) {
          bigEyeBoy.push('RED'); // Regularity
        } else {
          bigEyeBoy.push('BLUE'); // Irregularity
        }
      } else {
        // Compare row cell of C with corresponding row cell of C-1
        const sidePrev = hasCell(c - 1, r);
        const sidePrevOneUp = hasCell(c - 1, r - 1);
        
        // standard baccarat: if the previous column has a cell at the same row level => RED, else BLUE
        if (sidePrev) {
          bigEyeBoy.push('RED');
        } else {
          // Check if there is another turn/depth
          bigEyeBoy.push('BLUE');
        }
      }
    }
  }

  // 3. Derive Small Road (Compares current column to 2 columns back)
  // Started from column 3 (0-indexed: index 2), row 2 (0-indexed: index 1). If column is new, compares previous column with 3 columns ago.
  const smallRoad: ('RED' | 'BLUE')[] = [];
  for (let c = 2; c < pureBigRoad.length; c++) {
    const colLength = pureBigRoad[c].length;
    const startRow = (c === 2) ? 1 : 0; // skip first cell in column 3
    
    for (let r = startRow; r < colLength; r++) {
      if (r === 0) {
        const lenPrev = pureBigRoad[c - 1].length;
        const lenPrevPrevPrev = pureBigRoad[c - 3] ? pureBigRoad[c - 3].length : 0;
        if (lenPrev === lenPrevPrevPrev) {
          smallRoad.push('RED');
        } else {
          smallRoad.push('BLUE');
        }
      } else {
        const sidePrevPrev = hasCell(c - 2, r);
        if (sidePrevPrev) {
          smallRoad.push('RED');
        } else {
          smallRoad.push('BLUE');
        }
      }
    }
  }

  // 4. Pattern Analysis
  // Dragon Pattern analysis: A long active streak where the same result repeats 6 or more times (column height >= 5 or 6)
  let dragonCount = 0;
  let isDragonActive = false;
  let dragonSide: 'PLAYER' | 'BANKER' | null = null;
  
  if (pureBigRoad.length > 0) {
    const lastCol = pureBigRoad[pureBigRoad.length - 1];
    if (lastCol.length >= 5) {
      isDragonActive = true;
      dragonSide = lastCol[0].result;
    }
    
    // Count historic dragon occurrences in previous columns
    for (const col of pureBigRoad) {
      if (col.length >= 5) {
        dragonCount++;
      }
    }
  }

  // Ping-Pong Pattern analysis: continuous single alternation columns (e.g. [P], [B], [P], [B] cols of length 1)
  let pingPongLength = 0;
  let isPingPongActive = false;
  if (pureBigRoad.length >= 4) {
    let altCount = 0;
    // Walk backward checking if columns have length 1
    for (let c = pureBigRoad.length - 1; c >= 0; c--) {
      if (pureBigRoad[c].length === 1) {
        altCount++;
      } else {
        break;
      }
    }
    pingPongLength = altCount;
    if (altCount >= 4) {
      isPingPongActive = true;
    }
  }

  // Double check full continuous alternation (chop) strings
  let maxAlternation = 0;
  let currentAlternation = 0;
  for (let i = 0; i < nonTies.length; i++) {
    if (i === 0) {
      currentAlternation = 1;
    } else if (nonTies[i] !== nonTies[i - 1]) {
      currentAlternation++;
    } else {
      if (currentAlternation > maxAlternation) {
        maxAlternation = currentAlternation;
      }
      currentAlternation = 1; // Reset
    }
  }
  if (currentAlternation > maxAlternation) {
    maxAlternation = currentAlternation;
  }

  let activeAlternation = 0;
  if (nonTies.length > 0) {
    activeAlternation = 1;
    for (let i = nonTies.length - 1; i > 0; i--) {
      if (nonTies[i] !== nonTies[i - 1]) {
        activeAlternation++;
      } else {
        break;
      }
    }
  }

  // Calculate maximum single-side streaks (consecutive player or banker)
  let maxPlayerStreak = 0;
  let maxBankerStreak = 0;
  let currentPlayerStreak = 0;
  let currentBankerStreak = 0;
  
  for (let i = 0; i < nonTies.length; i++) {
    const item = nonTies[i];
    if (item === 'PLAYER') {
      currentPlayerStreak++;
      if (currentPlayerStreak > maxPlayerStreak) {
        maxPlayerStreak = currentPlayerStreak;
      }
      currentBankerStreak = 0;
    } else {
      currentBankerStreak++;
      if (currentBankerStreak > maxBankerStreak) {
        maxBankerStreak = currentBankerStreak;
      }
      currentPlayerStreak = 0;
    }
  }

  let currentStreak = 0;
  let currentStreakSide: 'PLAYER' | 'BANKER' | null = null;
  if (nonTies.length > 0) {
    currentStreakSide = nonTies[nonTies.length - 1];
    currentStreak = 1;
    for (let i = nonTies.length - 2; i >= 0; i--) {
      if (nonTies[i] === currentStreakSide) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  return {
    bigRoad,
    bigEyeBoy: bigEyeBoy.slice(-40), // return last 40 for UI density
    smallRoad: smallRoad.slice(-40),
    dragonCount,
    pingPongLength,
    isDragonActive,
    isPingPongActive,
    dragonSide,
    currentAlternation: activeAlternation,
    maxAlternation,
    maxPlayerStreak,
    maxBankerStreak,
    currentStreak,
    currentStreakSide
  };
}
