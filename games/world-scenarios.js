// Scenarios: initial stats per country for each historical setting
// Stats: army, economy, tech, personality, alliances, atWar
// Personalities: aggressive, diplomatic, economic, defensive, isolationist

module.exports = {
  scenarios: {
    '1936': {
      name: '1936 - Visperas de la Guerra',
      desc: 'Alemania nazi expandiendose, Japon en China, USA aislacionista. La tension europea crece.',
      year: 1936,
      stats: {
        // Powers
        DEU: { army: 250, eco: 180, tech: 5, pers: 'aggressive', allies: ['ITA'], war: [] },
        ITA: { army: 150, eco: 120, tech: 4, pers: 'aggressive', allies: ['DEU'], war: [] },
        JPN: { army: 220, eco: 150, tech: 5, pers: 'aggressive', allies: [], war: ['CHN'] },
        GBR: { army: 200, eco: 250, tech: 5, pers: 'defensive', allies: ['FRA'], war: [] },
        FRA: { army: 180, eco: 200, tech: 5, pers: 'defensive', allies: ['GBR'], war: [] },
        USA: { army: 120, eco: 350, tech: 5, pers: 'isolationist', allies: [], war: [] },
        RUS: { army: 280, eco: 180, tech: 4, pers: 'defensive', allies: [], war: [] },
        CHN: { army: 150, eco: 100, tech: 2, pers: 'defensive', allies: [], war: ['JPN'] },
        // Major
        ESP: { army: 80, eco: 70, tech: 3, pers: 'defensive', allies: [], war: [] },
        POL: { army: 100, eco: 80, tech: 3, pers: 'defensive', allies: ['FRA'], war: [] },
        BRA: { army: 60, eco: 90, tech: 3, pers: 'isolationist', allies: [], war: [] },
        MEX: { army: 40, eco: 60, tech: 2, pers: 'isolationist', allies: [], war: [] },
        ARG: { army: 50, eco: 80, tech: 3, pers: 'isolationist', allies: [], war: [] },
        TUR: { army: 90, eco: 70, tech: 3, pers: 'defensive', allies: [], war: [] },
        IRN: { army: 50, eco: 60, tech: 2, pers: 'defensive', allies: [], war: [] },
        EGY: { army: 40, eco: 50, tech: 2, pers: 'defensive', allies: ['GBR'], war: [] },
        IND: { army: 80, eco: 100, tech: 2, pers: 'defensive', allies: ['GBR'], war: [] },
        AUS: { army: 50, eco: 90, tech: 4, pers: 'defensive', allies: ['GBR'], war: [] },
        CAN: { army: 50, eco: 100, tech: 4, pers: 'defensive', allies: ['GBR'], war: [] },
      }
    },

    '2026': {
      name: '2026 - Tension Moderna',
      desc: 'USA vs Iran al borde de la guerra. Rusia y China desafian a Occidente. Mundo polarizado.',
      year: 2026,
      stats: {
        // Superpowers
        USA: { army: 350, eco: 600, tech: 9, pers: 'aggressive', allies: ['GBR','FRA','DEU','JPN','KOR','ISR','CAN','AUS'], war: [] },
        CHN: { army: 380, eco: 550, tech: 9, pers: 'aggressive', allies: ['RUS','PRK','PAK'], war: [] },
        RUS: { army: 320, eco: 200, tech: 8, pers: 'aggressive', allies: ['CHN','PRK','IRN','SYR'], war: [] },
        // Major
        IRN: { army: 180, eco: 100, tech: 6, pers: 'aggressive', allies: ['RUS','SYR'], war: [] },
        ISR: { army: 200, eco: 200, tech: 9, pers: 'defensive', allies: ['USA'], war: [] },
        IND: { army: 280, eco: 300, tech: 7, pers: 'defensive', allies: [], war: [] },
        PAK: { army: 180, eco: 80, tech: 5, pers: 'defensive', allies: ['CHN'], war: [] },
        JPN: { army: 180, eco: 380, tech: 9, pers: 'defensive', allies: ['USA','KOR'], war: [] },
        KOR: { army: 180, eco: 250, tech: 9, pers: 'defensive', allies: ['USA','JPN'], war: [] },
        PRK: { army: 200, eco: 30, tech: 5, pers: 'aggressive', allies: ['CHN','RUS'], war: [] },
        // Europe
        GBR: { army: 150, eco: 280, tech: 9, pers: 'defensive', allies: ['USA','FRA','DEU'], war: [] },
        FRA: { army: 160, eco: 270, tech: 9, pers: 'defensive', allies: ['USA','GBR','DEU'], war: [] },
        DEU: { army: 130, eco: 320, tech: 9, pers: 'defensive', allies: ['USA','GBR','FRA'], war: [] },
        UKR: { army: 150, eco: 50, tech: 6, pers: 'defensive', allies: ['USA','GBR'], war: ['RUS'] },
        POL: { army: 120, eco: 150, tech: 7, pers: 'defensive', allies: ['USA','DEU'], war: [] },
        TUR: { army: 220, eco: 150, tech: 7, pers: 'aggressive', allies: [], war: [] },
        ITA: { army: 110, eco: 220, tech: 8, pers: 'defensive', allies: ['USA','FRA','DEU'], war: [] },
        ESP: { army: 90, eco: 180, tech: 8, pers: 'defensive', allies: ['USA','FRA'], war: [] },
        // Americas
        CAN: { army: 80, eco: 250, tech: 9, pers: 'defensive', allies: ['USA'], war: [] },
        MEX: { army: 100, eco: 180, tech: 6, pers: 'isolationist', allies: [], war: [] },
        BRA: { army: 150, eco: 200, tech: 6, pers: 'diplomatic', allies: [], war: [] },
        ARG: { army: 70, eco: 100, tech: 6, pers: 'diplomatic', allies: [], war: [] },
        // Middle East
        SAU: { army: 150, eco: 250, tech: 7, pers: 'defensive', allies: ['USA'], war: [] },
        ARE: { army: 80, eco: 200, tech: 8, pers: 'diplomatic', allies: ['USA'], war: [] },
        IRQ: { army: 80, eco: 70, tech: 4, pers: 'defensive', allies: [], war: [] },
        SYR: { army: 70, eco: 30, tech: 4, pers: 'defensive', allies: ['RUS','IRN'], war: [] },
        EGY: { army: 200, eco: 120, tech: 6, pers: 'defensive', allies: [], war: [] },
        // Africa
        ZAF: { army: 70, eco: 100, tech: 6, pers: 'diplomatic', allies: [], war: [] },
        NGA: { army: 80, eco: 80, tech: 4, pers: 'defensive', allies: [], war: [] },
        // Oceania
        AUS: { army: 90, eco: 220, tech: 9, pers: 'defensive', allies: ['USA','GBR'], war: [] },
      }
    }
  },

  // Default stats for countries not specified in a scenario (small/passive)
  defaultStats: function(scenario) {
    return scenario === '2026'
      ? { army: 30, eco: 40, tech: 4, pers: 'isolationist', allies: [], war: [] }
      : { army: 20, eco: 30, tech: 2, pers: 'isolationist', allies: [], war: [] };
  }
};
