'use strict';
// ENGINE: servidor autoritativo (movimento, combate, mapas, portas, eventos, visibilidade) + cliente embutido (PAGE).
// BIBLIOTECA: BASE (modelos padrão) + modelos salvos pelo mestre (room.lib).
// CAMPANHA: vários mapas ligados por portas, cada um com terreno e objetos; exportável em JSON.
const http = require('http'), crypto = require('crypto'), { Server } = require('socket.io');
const PORT = process.env.PORT || 3000, TS = 32, MAXW = 80, MAXH = 60, NT = 32, SOLID = [2, 3, 7, 16, 17, 26, 30, 31]; // terrenos sólidos: parede, água, abismo, lava, tijolos, parede de madeira/pedra/clara
const KINDS = ['npc', 'enemy', 'prop', 'clue', 'event', 'spawn', 'door'];
const ACTS = ['say', 'dialog', 'spawn', 'tp', 'show', 'lock', 'heal', 'hurt', 'clue'];
const PSPR = ['investigador', 'ocultista', 'soldado', 'medica', 'policial', 'detetive', 'jornalista', 'cientista'];

const BASE = [
  { id: 'zumbi', kind: 'enemy', name: 'Zumbi', spr: 'zumbi', hp: 20, atk: 4, spd: 55 },
  { id: 'esqueleto', kind: 'enemy', name: 'Esqueleto', spr: 'esqueleto', hp: 14, atk: 5, spd: 75 },
  { id: 'cultista', kind: 'enemy', name: 'Cultista', spr: 'cultista', hp: 14, atk: 5, spd: 80 },
  { id: 'sombra', kind: 'enemy', name: 'Sombra', spr: 'sombra', hp: 16, atk: 6, spd: 90 },
  { id: 'cao', kind: 'enemy', name: 'Cão infernal', spr: 'cao', hp: 18, atk: 6, spd: 110 },
  { id: 'olho', kind: 'enemy', name: 'Olho flutuante', spr: 'olho', hp: 30, atk: 7, spd: 50 },
  { id: 'criatura', kind: 'enemy', name: 'Criatura do Outro Lado', spr: 'criatura', hp: 45, atk: 9, spd: 65 },
  { id: 'npc_aldeao', kind: 'npc', name: 'Sobrevivente', spr: 'aldeao', dialog: ['Você viu aquilo? Não saia sozinho.'] },
  { id: 'npc_padre', kind: 'npc', name: 'Padre', spr: 'padre', dialog: ['Esta casa guarda algo que não deveria ser acordado.'] },
  { id: 'npc_policial', kind: 'npc', name: 'Policial', spr: 'policial', dialog: ['Isolamos a área. Ninguém passa sem autorização.'] },
  { id: 'npc_medica', kind: 'npc', name: 'Médica', spr: 'medica', dialog: ['Fique perto de mim se estiver ferido.'] },
  { id: 'npc_ocultista', kind: 'npc', name: 'Ocultista', spr: 'ocultista', dialog: ['O Outro Lado responde a quem sabe chamar.'] },
  { id: 'caixa', kind: 'prop', name: 'Caixote', spr: 'caixa', solid: true },
  { id: 'barril', kind: 'prop', name: 'Barril', spr: 'barril', solid: true },
  { id: 'bau', kind: 'prop', name: 'Baú', spr: 'bau', solid: true },
  { id: 'mesa', kind: 'prop', name: 'Mesa', spr: 'mesa', solid: true },
  { id: 'cama', kind: 'prop', name: 'Cama', spr: 'cama', solid: true },
  { id: 'estante', kind: 'prop', name: 'Estante', spr: 'estante', solid: true },
  { id: 'arvore', kind: 'prop', name: 'Árvore', spr: 'arvore', solid: true },
  { id: 'lapide', kind: 'prop', name: 'Lápide', spr: 'lapide', solid: true },
  { id: 'altar', kind: 'prop', name: 'Altar', spr: 'altar', solid: true },
  { id: 'tocha', kind: 'prop', name: 'Tocha', spr: 'tocha' },
  { id: 'papel', kind: 'clue', name: 'Bilhete', spr: 'papel', text: 'Escreva aqui a informação da pista.', hidden: true },
  { id: 'diario', kind: 'clue', name: 'Diário', spr: 'diario', text: 'Escreva aqui o conteúdo do diário.', hidden: true },
  { id: 'chave', kind: 'clue', name: 'Chave', spr: 'chave', text: 'Uma chave antiga. Abre algo importante.', hidden: true },
  { id: 'porta', kind: 'door', name: 'Porta', spr: 'porta', to: '', tx: -1, ty: -1, group: true },
  { id: 'escada', kind: 'door', name: 'Escada', spr: 'escada', to: '', tx: -1, ty: -1, group: true },
  { id: 'portal', kind: 'door', name: 'Portal', spr: 'portal', to: '', tx: -1, ty: -1, group: true },
  { id: 'gatilho', kind: 'event', name: 'Emboscada', spr: 'runa', when: 'enter', r: 64, once: true, hidden: true,
    acts: [{ t: 'say', text: 'Algo se move nas sombras...' }, { t: 'spawn', lib: 'zumbi', count: 2 }] },
  { id: 'alavanca', kind: 'event', name: 'Alavanca', spr: 'alavanca', when: 'interact', r: 40, once: true,
    acts: [{ t: 'say', text: 'Você ouve um clique distante.' }] },
  { id: 'inicio', kind: 'spawn', name: 'Início', spr: 'bandeira' }
];

// ================= CATÁLOGO ESTENDIDO =================
// Cenário: [id, nome, colisão largura, colisão altura] em células (largura 0 = atravessável). O sprite tem o mesmo id.
const PROPS = [
  // Móveis e casa
  ['sofa', 'Sofá', 2, 1], ['poltrona', 'Poltrona', 1, 1], ['cadeira', 'Cadeira', 1, 1], ['banco', 'Banco', 1, 1], ['cadeira_balanco', 'Cadeira de balanço', 1, 1],
  ['mesa_longa', 'Mesa longa', 2, 1], ['mesa_redonda', 'Mesa redonda', 1, 1], ['escrivaninha', 'Escrivaninha', 1, 1], ['cama_casal', 'Cama de casal', 2, 1],
  ['beliche', 'Beliche', 1, 1], ['berco', 'Berço', 1, 1], ['armario', 'Armário', 1, 1], ['comoda', 'Cômoda', 1, 1], ['criado_mudo', 'Criado-mudo', 1, 1],
  ['espelho_pe', 'Espelho de chão', 1, 1], ['lareira', 'Lareira', 1, 1], ['fogao', 'Fogão a lenha', 1, 1], ['geladeira', 'Geladeira', 1, 1], ['pia', 'Pia', 1, 1],
  ['banheira', 'Banheira', 2, 1], ['vaso', 'Vaso sanitário', 1, 1], ['tv_antiga', 'TV antiga', 1, 1], ['piano', 'Piano', 2, 1], ['relogio_pe', 'Relógio de pé', 1, 1],
  ['estante_larga', 'Estante larga', 2, 1], ['vitrola', 'Vitrola', 1, 1], ['quadro', 'Quadro', 0], ['quadro_sinistro', 'Retrato sinistro', 0], ['janela', 'Janela', 0],
  ['saco', 'Saco', 1, 1], ['fardo_feno', 'Fardo de feno', 1, 1], ['engradado', 'Engradado de garrafas', 1, 1], ['bancada_trabalho', 'Bancada de trabalho', 2, 1], ['carrinho_mao', 'Carrinho de mão', 1, 1],
  // Natureza
  ['arvore_morta', 'Árvore morta', 1, 1], ['pinheiro', 'Pinheiro', 1, 1], ['carvalho', 'Carvalho', 1, 1], ['salgueiro', 'Salgueiro', 1, 1], ['palmeira', 'Palmeira', 1, 1],
  ['arbusto', 'Arbusto', 1, 1], ['arbusto_flores', 'Arbusto florido', 1, 1], ['grama_alta', 'Mato alto', 0], ['flores', 'Flores', 0], ['cogumelos', 'Cogumelos', 0],
  ['pedra', 'Pedra', 1, 1], ['pedregulho', 'Pedregulho', 2, 1], ['tronco_caido', 'Tronco caído', 2, 1], ['toco', 'Toco', 1, 1], ['poco', 'Poço', 1, 1],
  ['fogueira', 'Fogueira', 0], ['barraca', 'Barraca de camping', 2, 2], ['espantalho', 'Espantalho', 1, 1], ['cerca_madeira', 'Cerca de madeira', 1, 1],
  ['cerca_quebrada', 'Cerca quebrada', 1, 1], ['canteiro', 'Canteiro', 0], ['abobora', 'Abóbora', 0], ['lenha', 'Pilha de lenha', 1, 1],
  // Cemitério
  ['cruz', 'Cruz de pedra', 1, 1], ['lapide_cruz', 'Lápide com cruz', 1, 1], ['lapide_antiga', 'Lápide antiga', 1, 1], ['tumulo', 'Túmulo', 2, 1],
  ['estatua_anjo', 'Estátua de anjo', 1, 1], ['gargula', 'Gárgula', 1, 1], ['caixao', 'Caixão', 1, 1], ['caixao_aberto', 'Caixão aberto', 1, 1],
  ['urna', 'Urna funerária', 1, 1], ['cruz_madeira', 'Cruz de madeira', 1, 1], ['grade_ferro', 'Grade de ferro', 1, 1],
  // Ocultismo
  ['caldeirao', 'Caldeirão', 1, 1], ['vela', 'Vela', 0], ['velas', 'Velas', 0], ['candelabro', 'Candelabro', 1, 1], ['altar_sacrificio', 'Altar de sacrifício', 2, 1],
  ['totem', 'Totem', 1, 1], ['idolo', 'Ídolo sombrio', 1, 1], ['cristal', 'Cristal', 1, 1], ['espelho_negro', 'Espelho amaldiçoado', 1, 1], ['olho_parede', 'Olho na parede', 0],
  ['livro_pedestal', 'Livro no pedestal', 1, 1], ['bola_cristal', 'Bola de cristal', 1, 1], ['cranio_vela', 'Crânio com vela', 0], ['boneca_pano', 'Boneca de pano', 0],
  ['jaula', 'Jaula', 1, 1], ['correntes', 'Correntes', 0], ['monolito', 'Monólito rúnico', 1, 1], ['obelisco', 'Obelisco', 1, 1], ['tentaculos', 'Tentáculos', 1, 1], ['casulo', 'Casulo', 1, 1],
  // Cidade e veículos
  ['poste', 'Poste de luz', 1, 1], ['semaforo', 'Semáforo', 1, 1], ['placa_pare', 'Placa de pare', 1, 1], ['placa', 'Placa', 1, 1], ['hidrante', 'Hidrante', 1, 1],
  ['lixeira', 'Lixeira', 1, 1], ['container', 'Container', 2, 1], ['banco_praca', 'Banco de praça', 2, 1], ['cabine_tel', 'Cabine telefônica', 1, 1], ['correio', 'Caixa de correio', 1, 1],
  ['carro_azul', 'Carro azul', 2, 1], ['carro_vermelho', 'Carro vermelho', 2, 1], ['carro_policia', 'Viatura', 2, 1], ['ambulancia', 'Ambulância', 2, 1], ['van', 'Van', 2, 1], ['onibus', 'Ônibus', 3, 1],
  ['fonte_praca', 'Fonte de praça', 2, 2], ['estatua_praca', 'Estátua de praça', 1, 1], ['barreira', 'Barreira', 1, 1], ['cone', 'Cone', 0], ['fita_policia', 'Fita da polícia', 1, 1],
  ['barraca_feira', 'Barraca de feira', 2, 1], ['outdoor', 'Outdoor', 2, 1], ['carrinho_compras', 'Carrinho de compras', 1, 1], ['ponto_onibus', 'Ponto de ônibus', 2, 1],
  ['muro_baixo', 'Muro baixo', 1, 1], ['cerca_arame', 'Cerca de arame', 1, 1], ['caixa_luz', 'Caixa de luz', 1, 1],
  // Hospital e laboratório
  ['cama_hospital', 'Cama de hospital', 1, 1], ['maca', 'Maca', 1, 1], ['armario_med', 'Armário médico', 1, 1], ['cadeira_rodas', 'Cadeira de rodas', 1, 1], ['monitor_med', 'Monitor cardíaco', 1, 1],
  ['bancada_lab', 'Bancada de laboratório', 2, 1], ['tanque', 'Tanque de espécime', 1, 1], ['computador', 'Computador', 1, 1], ['servidor', 'Servidor', 1, 1],
  ['cofre_forte', 'Cofre', 1, 1], ['gerador', 'Gerador', 1, 1], ['mesa_cirurgia', 'Mesa de cirurgia', 2, 1],
  // Iluminação
  ['tocha_parede', 'Tocha de parede', 0], ['lampiao', 'Lampião', 0], ['lampada_pend', 'Lâmpada pendente', 0], ['braseiro', 'Braseiro', 1, 1], ['abajur', 'Abajur', 0],
  // Chão (decalques, sempre atrás de tudo)
  ['sangue_poca', 'Poça de sangue', 0], ['sangue_respingo', 'Respingos de sangue', 0], ['pegadas_sangue', 'Pegadas de sangue', 0], ['rastro_sangue', 'Rastro de sangue', 0],
  ['giz_corpo', 'Contorno de giz', 0], ['circulo_ritual', 'Círculo ritual', 0], ['pentagrama', 'Pentagrama', 0], ['runas_chao', 'Runas brilhantes', 0], ['rachadura', 'Rachadura', 0],
  ['poca_agua', 'Poça de água', 0], ['lixo', 'Lixo', 0], ['folhas_soltas', 'Folhas soltas', 0], ['ossos', 'Ossos', 0], ['teia_canto', 'Teia de aranha', 0], ['cinzas', 'Cinzas', 0],
  ['vidro_quebrado', 'Vidro quebrado', 0], ['mancha_oleo', 'Mancha de óleo', 0], ['escombros', 'Escombros', 0], ['faixa_pedestre', 'Faixa de pedestres', 0],
  ['pegadas_lama', 'Pegadas de lama', 0], ['marca_queimada', 'Marca de queimado', 0], ['gosma_chao', 'Gosma', 0], ['tapete_vermelho', 'Tapete vermelho', 0],
  ['tapete_azul', 'Tapete azul', 0], ['tapete_redondo', 'Tapete redondo', 0], ['tapete_persa', 'Tapete persa', 0], ['cova_aberta', 'Cova aberta', 0], ['bueiro', 'Bueiro', 0], ['fenda', 'Fenda sobrenatural', 0]
];
PROPS.forEach(([id, name, fw, fh]) => BASE.push({ id, kind: 'prop', name, spr: id, solid: fw > 0, fw: fw || 1, fh: fh || 1 }));

// Construções: [id, nome, colisão largura, colisão altura, só decoração?]. Cada uma vira um prop (decoração) e, se não for decoração, uma porta "_in" (entrada para outro mapa).
// A base da construção fica na célula clicada (a porta fica no meio da base); a colisão cobre a construção toda.
const BLD = [['casa_pequena', 'Casa pequena', 4, 3], ['casa_grande', 'Casa grande', 5, 4], ['casebre', 'Casebre de madeira', 3, 3], ['mansao', 'Mansão', 7, 5],
  ['igreja', 'Igreja', 5, 5], ['capela', 'Capela', 3, 3], ['delegacia', 'Delegacia', 5, 3], ['hospital', 'Hospital', 6, 4], ['loja', 'Loja', 4, 3], ['bar', 'Bar', 4, 3],
  ['celeiro', 'Celeiro', 5, 4], ['galpao', 'Galpão', 5, 3], ['casa_abandonada', 'Casa abandonada', 4, 3], ['mausoleu', 'Mausoléu', 3, 3], ['farol', 'Farol', 2, 5],
  ['moinho', 'Moinho', 3, 5], ['ruina', 'Casa em ruínas', 4, 3, 1]];
BLD.forEach(([id, name, fw, fh, deco]) => {
  BASE.push({ id, kind: 'prop', name, spr: id, solid: true, fw, fh });
  if (!deco) BASE.push({ id: id + '_in', kind: 'door', name, spr: id, to: '', tx: -1, ty: -1, group: true, solid: true, fw, fh });
});
[['porta_dupla', 'Porta dupla'], ['porta_ferro', 'Porta de ferro'], ['alcapao', 'Alçapão'], ['portao_ferro', 'Portão de ferro'], ['caverna', 'Entrada de caverna'],
  ['elevador', 'Elevador'], ['passagem', 'Passagem escura']].forEach(([id, name]) => BASE.push({ id, kind: 'door', name, spr: id, to: '', tx: -1, ty: -1, group: true }));

// Inimigos: [id, nome, vida, ataque, velocidade]
[['aranha', 'Aranha gigante', 10, 4, 100], ['morcego', 'Morcego', 8, 3, 120], ['rato', 'Rato', 6, 2, 95], ['corvo', 'Corvo', 8, 3, 110], ['fantasma', 'Fantasma', 25, 6, 70],
  ['lobo', 'Lobo', 16, 5, 115], ['possuido', 'Possuído', 30, 7, 70], ['carnical', 'Carniçal', 26, 6, 80], ['mumia', 'Múmia', 35, 7, 50], ['demonio', 'Demônio', 60, 12, 75],
  ['tentaculo', 'Tentáculo', 40, 8, 0], ['boneca', 'Boneca amaldiçoada', 12, 5, 85], ['vulto', 'Vulto', 50, 10, 100], ['larva', 'Larva gigante', 22, 4, 40], ['gosma', 'Gosma', 18, 3, 45]]
  .forEach(([id, name, hp, atk, spd]) => BASE.push({ id, kind: 'enemy', name, spr: id, hp, atk, spd }));

// NPCs: [sprite, nome, fala]
[['detetive', 'Detetive', 'Cada detalhe importa. Ninguém aqui é tão inocente quanto parece.'], ['jornalista', 'Jornalista', 'Investigo esses desaparecimentos há meses. Posso dividir o que sei.'],
  ['cientista', 'Cientista', 'Os instrumentos enlouquecem perto daquele lugar. Isso não é natural.'], ['medico', 'Médico', 'Mantenha a calma. Os ferimentos são sérios, mas posso ajudar.'],
  ['delegado', 'Delegado', 'Este caso foi arquivado. Eu mesmo mandei arquivar. Pergunte-me por quê.'], ['mendigo', 'Mendigo', 'Eu vi as luzes na floresta. Ninguém acredita em mim.'],
  ['fazendeiro', 'Fazendeiro', 'Meus animais pararam de comer. Algo anda rondando à noite.'], ['velha', 'Senhora idosa', 'Minha avó dizia que aquela casa nunca devia ter sido construída.'],
  ['guarda', 'Guarda', 'Área restrita. Volte por onde veio.'], ['comerciante', 'Comerciante', 'Tenho de tudo, menos coragem. O que vai querer?'],
  ['cozinheira', 'Cozinheira', 'A despensa... alguém mexeu nela esta noite.']]
  .forEach(([spr, name, line]) => BASE.push({ id: 'npc_' + spr, kind: 'npc', name, spr, dialog: [line] }));

// Pistas: [id, nome, texto]
[['foto', 'Fotografia', 'Uma fotografia antiga. Há uma silhueta estranha ao fundo, que não deveria estar ali.'], ['fita_cassete', 'Fita cassete', 'Uma fita com uma gravação. Dá para ouvir sussurros por trás da voz.'],
  ['mapa', 'Mapa', 'Um mapa rabiscado à mão, com um local marcado em vermelho.'], ['livro_antigo', 'Livro antigo', 'Um livro de capa de couro. Muitas páginas foram arrancadas.'],
  ['grimorio', 'Grimório', 'Símbolos que parecem se mexer quando você desvia o olhar.'], ['carta', 'Carta', 'Uma carta lacrada. A letra é trêmula e apressada.'],
  ['amuleto', 'Amuleto', 'Um amuleto frio ao toque. Parece reagir à presença do Outro Lado.'], ['faca_ritual', 'Faca ritual', 'Uma faca de lâmina curva, manchada. Usada em algum ritual.'],
  ['cranio', 'Crânio', 'Um crânio com símbolos gravados na testa.'], ['celular', 'Celular', 'Um celular rachado com uma última mensagem não enviada.'],
  ['gravador', 'Gravador', 'A última gravação tem três minutos de silêncio e um grito.'], ['pergaminho', 'Pergaminho', 'Instruções para um ritual, escritas em tinta escura.'],
  ['frasco', 'Frasco', 'Um líquido esverdeado. O rótulo foi raspado.'], ['relogio_bolso', 'Relógio de bolso', 'Parado no exato minuto do desaparecimento.']]
  .forEach(([id, name, text]) => BASE.push({ id, kind: 'clue', name, spr: id, text, hidden: true }));

// Eventos prontos (o mestre edita as ações depois)
BASE.push(
  { id: 'armadilha', kind: 'event', name: 'Armadilha', spr: 'armadilha', when: 'enter', r: 28, once: false, hidden: true, acts: [{ t: 'hurt', v: 4 }, { t: 'say', text: 'Uma armadilha!' }] },
  { id: 'sussurros', kind: 'event', name: 'Sussurros', spr: 'sussurro', when: 'enter', r: 80, once: true, hidden: true, acts: [{ t: 'say', text: 'Você ouve sussurros vindos das paredes...' }] },
  { id: 'cena', kind: 'event', name: 'Cena com diálogo', spr: 'cena', when: 'enter', r: 64, once: true, hidden: true, acts: [{ t: 'dialog', name: 'Voz', spr: 'vulto', lines: ['Vocês não deviam ter vindo.'] }] },
  { id: 'gaveta', kind: 'event', name: 'Gaveta', spr: 'gaveta', when: 'interact', r: 40, once: true, acts: [{ t: 'say', text: 'Dentro da gaveta há algo escondido.' }, { t: 'clue', name: 'Achado na gaveta', text: 'Escreva aqui o que foi encontrado.' }] },
  { id: 'fonte_cura', kind: 'event', name: 'Ponto de cura', spr: 'cura', when: 'interact', r: 40, once: false, acts: [{ t: 'heal' }, { t: 'say', text: 'Você se sente renovado.' }] },
  { id: 'ritual', kind: 'event', name: 'Ritual interrompido', spr: 'runa', when: 'enter', r: 96, once: true, hidden: true, acts: [{ t: 'say', text: 'Os cultistas se viram para vocês!' }, { t: 'spawn', lib: 'cultista', count: 3 }] },
  { id: 'sala_limpa', kind: 'event', name: 'Sala limpa', spr: 'runa', when: 'clear', r: 64, once: true, hidden: true, acts: [{ t: 'say', text: 'O silêncio volta ao lugar.' }] }
);


const rooms = new Map();
const rnd = n => Math.random() * n, uid = () => crypto.randomBytes(8).toString('hex');
const cl = (v, a, b) => Math.min(b, Math.max(a, +v || 0));
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const libOf = r => BASE.concat(r.lib);
const mapPub = m => ({ id: m.id, name: m.name, w: m.w, h: m.h, tiles: m.tiles });

function cleanActs(a) {
  return (Array.isArray(a) ? a : []).slice(0, 20).map(x => x || {}).map(x => ({
    t: ACTS.includes(x.t) ? x.t : 'say', text: str(x.text, 300), name: str(x.name, 40), spr: str(x.spr, 20),
    lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 20).map(s => str(s, 300)).filter(Boolean),
    lib: str(x.lib, 30), count: cl(x.count, 0, 10), map: str(x.map, 12), x: cl(x.x, -1, MAXW), y: cl(x.y, -1, MAXH),
    target: str(x.target, 12), v: typeof x.v === 'boolean' ? x.v : cl(x.v, 0, 999)
  }));
}
// Normaliza/valida um objeto vindo do mestre (cria ou atualiza `old`).
function clean(o, old) {
  o = o || {};
  const k = KINDS.includes(o.kind) ? o.kind : old && old.kind;
  if (!k) return null;
  const r = old || { id: null, kind: k };
  const g = (f, d) => o[f] != null ? o[f] : r[f] != null ? r[f] : d;
  r.x = cl(g('x', 0), 0, MAXW * TS); r.y = cl(g('y', 0), 0, MAXH * TS);
  r.name = str(g('name', ''), 40);
  const sp = g('spr', ''); r.spr = /^[a-z_]{1,20}$/.test(sp) ? sp : 'caixa';
  r.note = str(g('note', ''), 500); r.text = str(g('text', ''), 1500);
  r.hidden = k === 'spawn' ? true : !!g('hidden', false);
  r.solid = !!g('solid', false);
  r.fw = Math.floor(cl(g('fw', 1), 1, 12)); r.fh = Math.floor(cl(g('fh', 1), 1, 12)); // área de colisão em células
  r.dialog = (Array.isArray(o.dialog) ? o.dialog : r.dialog || []).slice(0, 30).map(s => str(s, 300)).filter(Boolean);
  if (k === 'enemy') {
    const hp = cl(g('hp', g('maxhp', 20)), 1, 9999);
    if (!r.maxhp || o.hp != null) { r.maxhp = hp; r.hp = hp; }
    r.atk = cl(g('atk', 4), 0, 999); r.spd = cl(g('spd', 60), 0, 200);
  }
  if (k === 'door') {
    r.to = str(g('to', ''), 12); r.tx = Math.floor(cl(g('tx', -1), -1, MAXW)); r.ty = Math.floor(cl(g('ty', -1), -1, MAXH));
    r.group = !!g('group', true); r.locked = !!g('locked', false);
  }
  if (k === 'event') {
    const w = g('when', 'enter'); r.when = ['enter', 'interact', 'clear'].includes(w) ? w : 'enter';
    r.r = cl(g('r', 64), 16, 400); r.once = !!g('once', true);
    if (o.reset) r.done = false;
    r.acts = cleanActs(o.acts != null ? o.acts : r.acts);
  }
  return r;
}
// Versão do mapa: muda sempre que um objeto não-móvel muda. O servidor só reenvia os objetos estáticos quando a versão muda.
const dirty = (r, m) => { m.v = ++r.vseq; };
const isMov = o => o.kind === 'enemy';
function addObj(r, m, d) {
  if (m.objs.length >= 500) return null;
  const n = clean(d); if (!n) return null;
  n.id = 'o' + r.seq++; m.objs.push(n); dirty(r, m); return n;
}
// O que o jogador pode ver: nada de ocultos, início, notas, textos de pista ou ações de evento.
const pubObj = o => o.kind === 'spawn' || o.hidden ? null :
  { id: o.id, kind: o.kind, x: Math.round(o.x), y: Math.round(o.y), name: o.name, spr: o.spr, solid: o.solid, hp: o.hp, maxhp: o.maxhp };

// ---- geração de cenários ----
function gen(tpl, w, h) {
  const FILL = { casa: 1, cripta: 5, hospital: 24, mansao: 1, porao: 25, pantano: 15 }, BORD = { floresta: 7, cemiterio: 30, porao: 30, pantano: 7, hospital: 31, mansao: 26 };
  const t = new Array(w * h).fill(FILL[tpl] || 0), os = [];
  const S = (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) t[y * w + x] = v; };
  const bd = BORD[tpl] != null ? BORD[tpl] : 2, cx = w >> 1, cy = h >> 1;
  // P: coloca um item do catálogo na célula (x,y); objetos grandes usam a célula como base (meio da fileira de baixo)
  const P = (id, x, y) => { if (x >= 1 && y >= 1 && x < w - 1 && y < h - 1) os.push(Object.assign({}, BASE.find(b => b.id === id), { x: (x + .5) * TS, y: (y + .5) * TS })); };
  const rect = (x0, y0, x1, y1, v) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) S(x, y, v); };
  for (let i = 0; i < w; i++) { S(i, 0, bd); S(i, h - 1, bd); }
  for (let j = 0; j < h; j++) { S(0, j, bd); S(w - 1, j, bd); }
  if (tpl === 'casa') {
    for (let i = 1; i < w - 1; i++) S(i, cy, 2);
    for (let j = 1; j < h - 1; j++) S(cx, j, 2);
    [[cx, cy >> 1], [cx, cy + ((h - cy) >> 1)], [cx >> 1, cy], [cx + ((w - cx) >> 1), cy]].forEach(g => S(g[0], g[1], 1));
  }
  if (tpl === 'floresta') {
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (x * x + y * y <= 9) S((w >> 2) + x, (h >> 2) + y, 3);
    for (let i = 1; i < w - 1; i++) { const y = cy + Math.round(Math.sin(i / 4) * 2); S(i, y, 6); S(i, y + 1, 6); }
    for (let i = 0, n = (w * h / 28) | 0; i < n; i++) {
      const x = 1 + (rnd(w - 2) | 0), y = 1 + (rnd(h - 2) | 0);
      if (t[y * w + x] === 0 && Math.hypot(x - cx, y - cy) > 3) os.push(Object.assign({}, BASE.find(b => b.id === 'arvore'), { x: (x + .5) * TS, y: (y + .5) * TS }));
    }
  }
  if (tpl === 'cripta') {
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) { const d = Math.hypot(x, y); if (d <= 5 && d >= 3.5) S(cx + x, cy + y, 4); }
    [[-8, -6], [8, -6], [-8, 6], [8, 6]].forEach(g => { S(cx + g[0], cy + g[1], 2); S(cx + g[0] + 1, cy + g[1], 2); });
  }
  if (tpl === 'vila') {
    for (let x = 1; x < w - 1; x++) { S(x, cy - 2, 10); S(x, cy - 1, 11); S(x, cy, 12); S(x, cy + 1, 11); S(x, cy + 2, 10); }
    const casas = ['casa_pequena', 'casa_grande', 'loja', 'casebre', 'casa_pequena', 'bar'];
    for (let i = 0, x = 4; x < w - 4; i++, x += 6) {
      P(casas[i % 6] + '_in', x, cy - 4); P('poste', x + 3, cy - 2);
      if (i % 2) P(['carro_azul', 'carro_vermelho', 'van'][(i >> 1) % 3], x, i % 4 === 1 ? cy - 1 : cy + 1);
      P(['arvore', 'arbusto', 'lixeira', 'hidrante'][i % 4], x + 2, cy + 3);
      if (i % 3 === 0) P('banco_praca', x, cy + 3);
    }
    P('fonte_praca', cx, cy + 7); P('estatua_praca', cx - 5, cy + 7); P('banco_praca', cx + 5, cy + 7);
    for (let i = 0; i < w * h / 60; i++) P(['arvore', 'arvore', 'arbusto', 'flores', 'grama_alta'][rnd(5) | 0], 2 + (rnd(w - 4) | 0), cy + 4 + (rnd(Math.max(1, h - cy - 6)) | 0));
  }
  if (tpl === 'cemiterio') {
    for (let y = 1; y < h - 1; y++) { S(cx - 1, y, 20); S(cx, y, 20); }
    for (let x = 1; x < w - 1; x++) S(x, cy + 3, 20);
    for (let y = 8; y < h - 4; y += 3) for (let x = 3; x < w - 3; x += 3) {
      if (Math.abs(x - cx) < 3 || y === cy + 3 || rnd(1) < .25) continue;
      P(['lapide', 'lapide_cruz', 'lapide_antiga', 'cruz', 'lapide_cruz'][rnd(5) | 0], x, y);
    }
    P('mausoleu_in', cx, 5); P('portao_ferro', cx, h - 2); P('estatua_anjo', cx - 3, h - 3); P('estatua_anjo', cx + 3, h - 3);
    P('cova_aberta', cx - 6, cy); P('cova_aberta', cx + 7, cy + 6);
    for (let i = 0; i < w * h / 80; i++) P(['arvore_morta', 'arvore_morta', 'cruz_madeira', 'ossos', 'velas'][rnd(5) | 0], 2 + (rnd(w - 4) | 0), 2 + (rnd(h - 4) | 0));
  }
  if (tpl === 'hospital') {
    const y1 = cy - 2, y2 = cy + 2;
    rect(1, cy - 1, w - 2, cy + 1, 13);
    for (let x = 1; x < w - 1; x++) if (x % 8 !== 4) { S(x, y1, 31); S(x, y2, 31); }
    for (let x = 8; x < w - 1; x += 8) { for (let y = 1; y < y1; y++) S(x, y, 31); for (let y = y2 + 1; y < h - 1; y++) S(x, y, 31); }
    for (let x = 1; x + 6 < w; x += 8) { P('cama_hospital', x + 2, 3); P('monitor_med', x + 3, 3); P('armario_med', x + 5, 2); P('maca', x + 2, y2 + 3); P('cadeira_rodas', x + 5, y2 + 4); }
    P('maca', cx + 4, cy); P('sangue_respingo', cx + 1, cy); P('pegadas_sangue', cx - 2, cy + 1); P('cadeira_rodas', 3, cy - 1);
  }
  if (tpl === 'mansao') {
    rect(cx - 2, 1, cx + 1, h - 2, 14);
    for (let y = 1; y < h - 1; y++) if (y % 7 !== 3) { S(cx - 3, y, 26); S(cx + 2, y, 26); }
    for (let x = 1; x < cx - 3; x++) if (x % 6 !== 3) S(x, cy, 26);
    for (let x = cx + 3; x < w - 1; x++) if ((x - cx) % 6 !== 3) S(x, cy, 26);
    P('relogio_pe', cx - 2, 2); P('relogio_pe', cx + 1, 2); P('candelabro', cx - 2, cy - 2); P('candelabro', cx + 1, cy - 2); P('espelho_pe', cx - 2, h - 3);
    P('lareira', cx - 7, 2); P('poltrona', cx - 7, 4); P('estante_larga', 4, 2); P('mesa_redonda', cx - 11, cy - 4); P('cadeira', cx - 13, cy - 4); P('cadeira', cx - 9, cy - 4); P('quadro_sinistro', cx - 10, 1);
    P('piano', cx + 7, 3); P('banco', cx + 7, 5); P('lareira', cx + 12, 2); P('sofa', cx + 9, cy - 3); P('candelabro', cx + 14, cy - 2); P('quadro', cx + 5, 1);
    P('cama_casal', 5, cy + 3); P('criado_mudo', 8, cy + 3); P('armario', 3, h - 3); P('comoda', 10, h - 3); P('cadeira_balanco', cx - 8, h - 4);
    P('mesa_longa', cx + 8, cy + 5); P('cadeira', cx + 6, cy + 4); P('cadeira', cx + 10, cy + 4); P('geladeira', cx + 12, h - 3); P('fogao', cx + 10, h - 3); P('pia', cx + 8, h - 3);
  }
  if (tpl === 'porao') {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) { const d = Math.hypot(x, y); if (d <= 4 && d >= 2.8) S(cx + x, cy + y, 4); }
    P('circulo_ritual', cx, cy); P('altar_sacrificio', cx, cy);
    [[-5, -5], [5, -5], [-5, 5], [5, 5], [0, -6], [0, 6], [-6, 0], [6, 0]].forEach(g => P('candelabro', cx + g[0], cy + g[1]));
    P('teia_canto', 1, 1); P('teia_canto', 1, h - 2);
    P('jaula', 3, 3); P('jaula', w - 4, 3); P('caixa', 3, h - 4); P('barril', 4, h - 4); P('engradado', w - 4, h - 4); P('ossos', cx + 3, cy + 6); P('estante', cx, 2); P('sangue_poca', cx - 3, cy + 5);
  }
  if (tpl === 'pantano') {
    const G = (x, y) => x >= 0 && y >= 0 && x < w && y < h ? t[y * w + x] : -1;
    for (let n = 0, k = Math.max(3, (w * h / 120) | 0); n < k; n++) {
      const px = 3 + (rnd(Math.max(1, w - 6)) | 0), py = 3 + (rnd(Math.max(1, h - 6)) | 0), rr = 2 + rnd(3);
      for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) {
        const d = Math.hypot(x, y);
        if (d <= rr) S(px + x, py + y, 3); else if (d <= rr + 1.3 && G(px + x, py + y) !== 3) S(px + x, py + y, 27);
      }
    }
    for (let x = 1; x < w - 1; x++) S(x, cy, 28);
    for (let i = 0, n = (w * h / 20) | 0; i < n; i++) {
      const x = 1 + (rnd(w - 2) | 0), y = 1 + (rnd(h - 2) | 0);
      if (y === cy || G(x, y) !== 15) continue;
      const k = rnd(10) | 0;
      if (k < 4) S(x, y, 18); else P(['arvore_morta', 'salgueiro', 'cogumelos', 'ossos', 'tronco_caido', 'pedra'][k - 4], x, y);
    }
  }
  return { tiles: t, objs: os };
}
function newMap(r, name, tpl, w, h) {
  const g = gen(tpl, w, h), m = { id: 'm' + r.mseq++, name, w, h, tiles: g.tiles, objs: [], seen: false, v: 0 };
  r.maps[m.id] = m;
  g.objs.forEach(o => addObj(r, m, o));
  addObj(r, m, Object.assign({}, BASE.find(b => b.id === 'inicio'), { x: (w >> 1) * TS + TS / 2, y: (h >> 1) * TS + TS / 2 }));
  return m;
}

// ---- simulação ----
const blocked = (m, x, y) => {
  const c = Math.floor(x / TS), d = Math.floor(y / TS);
  if (c < 0 || d < 0 || c >= m.w || d >= m.h || SOLID.includes(m.tiles[d * m.w + c])) return true;
  return m.objs.some(o => o.solid && Math.abs(o.x - x) < (o.fw || 1) * 16 && y > o.y - ((o.fh || 1) - 1) * TS - 16 && y < o.y + 16);
};
// Acha um ponto livre perto de (x,y) (evita nascer dentro de uma construção/objeto sólido).
function freeSpot(m, x, y) {
  if (!blocked(m, x, y)) return [x, y];
  for (let rr = 1; rr <= 10; rr++) for (let a = 0; a < 16; a++) {
    const nx = x + Math.cos(a * Math.PI / 8) * rr * 12, ny = y + Math.sin(a * Math.PI / 8) * rr * 12;
    if (!blocked(m, nx, ny)) return [nx, ny];
  }
  return [x, y];
}
const move = (m, e, dx, dy) => { if (!blocked(m, e.x + dx, e.y)) e.x += dx; if (!blocked(m, e.x, e.y + dy)) e.y += dy; };
const inMap = (r, id) => Object.values(r.players).filter(p => p.in && p.map === id);
// Envia a quem está no mapa `id` (jogadores) e ao mestre se ele estiver vendo esse mapa.
const tm = (r, id, ev, d, master = true) => {
  inMap(r, id).forEach(p => p.sid && io.to(p.sid).emit(ev, d));
  if (master && r.msid && r.mview === id) io.to(r.msid).emit(ev, d);
};
const pushMap = (r, m) => {
  const p = mapPub(m);
  if (r.msid && r.mview === m.id) io.to(r.msid).emit('map', p);
  inMap(r, m.id).forEach(q => q.sid && io.to(q.sid).emit('map', p));
};
const emitMaps = r => r.msid && io.to(r.msid).emit('maps', { list: Object.values(r.maps).map(m => ({ id: m.id, name: m.name })), start: r.start, view: r.mview });
const roster = r => io.to(r.code).emit('roster', {
  names: Object.values(r.players).map(p => p.name + (p.in && r.maps[p.map] ? ' @' + r.maps[p.map].name : '') + (p.sid ? '' : ' (off)')), playing: r.playing
});
const addJ = (r, id, t, x) => { if (!r.journal.some(j => j.id === id)) { r.journal.push({ id, t, x }); io.to(r.code).emit('journal', r.journal); } };

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
function derive(p) { p.maxhp = 12 + p.at.VIG * 4; p.atk = 2 + p.at.FOR * 2; p.spd = 90 + p.at.AGI * 14; p.def = Math.floor(p.at.VIG / 2); }
function newP(r, pid, sid, name, n) {
  const p = { pid, sid, name, map: r.start, spr: PSPR[n % PSPR.length], color: COLORS[n % COLORS.length], at: { FOR: 2, AGI: 2, INT: 1, PRE: 1, VIG: 2 }, x: 0, y: 0, ix: 0, iy: 0, dir: 0, cd: 0, dead: false, rt: 0, in: false };
  derive(p); p.hp = p.maxhp; return p;
}
// Move o jogador para um mapa (tx,ty em células; <0 = ponto de início do mapa).
function goto(r, p, mid, tx, ty) {
  const m = r.maps[mid]; if (!m) return;
  const sp = m.objs.find(o => o.kind === 'spawn');
  p.map = mid; p.ix = p.iy = 0; p.in = true;
  p.x = (tx >= 0 && ty >= 0 ? (tx + .5) * TS : sp ? sp.x : m.w * TS / 2) + rnd(10) - 5;
  p.y = (tx >= 0 && ty >= 0 ? (ty + .5) * TS : sp ? sp.y : m.h * TS / 2) + rnd(10) - 5;
  [p.x, p.y] = freeSpot(m, p.x, p.y); p.sv = '';
  if (p.sid) io.to(p.sid).emit('map', mapPub(m));
}
function spawnP(r, p) { goto(r, p, r.start, -1, -1); p.hp = p.maxhp; p.dead = false; }
const hurt = (r, p, d) => {
  p.hp -= d; tm(r, p.map, 'fx', { t: 'dmg', x: p.x, y: p.y, v: d, c: '#ff5555' });
  if (p.hp <= 0) { p.hp = 0; p.dead = true; p.rt = 8; tm(r, p.map, 'toast', p.name + ' caiu!'); }
};
// Executa as ações de um evento no mapa m.
function run(r, m, o) {
  for (const a of o.acts || []) {
    const ps = inMap(r, m.id);
    if (a.t === 'say') tm(r, m.id, 'toast', a.text);
    else if (a.t === 'dialog') tm(r, m.id, 'dialog', { name: a.name, spr: a.spr, lines: a.lines.length ? a.lines : ['...'] }, false);
    else if (a.t === 'spawn') {
      const t = libOf(r).find(l => l.id === a.lib && l.kind === 'enemy');
      if (t) for (let i = 0; i < a.count; i++) { const e = Object.assign({}, t, { x: o.x + rnd(80) - 40, y: o.y + rnd(80) - 40 }); delete e.id; addObj(r, m, e); }
    } else if (a.t === 'tp') ps.forEach(p => goto(r, p, a.map, a.x, a.y));
    else if (a.t === 'show') { const t = m.objs.find(x => x.id === a.target); if (t && t.kind !== 'spawn') t.hidden = !a.v; }
    else if (a.t === 'lock') { const t = m.objs.find(x => x.id === a.target && x.kind === 'door'); if (t) t.locked = !!a.v; }
    else if (a.t === 'heal') ps.forEach(p => { p.hp = p.maxhp; p.dead = false; });
    else if (a.t === 'hurt') ps.forEach(p => { if (!p.dead) hurt(r, p, a.v); });
    else if (a.t === 'clue') addJ(r, o.id + ':' + a.name, a.name || 'Pista', a.text);
  }
}
const fire = (r, m, o) => { if (o.once) o.done = true; else o.cd = 1.5; run(r, m, o); dirty(r, m); };

function step(r, dt) {
  if (!r.playing) return;
  const all = Object.values(r.players).filter(p => p.in);
  for (const p of all) {
    const m = r.maps[p.map]; if (!m) continue;
    if (p.dead) { if ((p.rt -= dt) <= 0) spawnP(r, p); continue; }
    p.cd = Math.max(0, p.cd - dt);
    const l = Math.hypot(p.ix, p.iy);
    if (l > 0) { const dx = p.ix / l, dy = p.iy / l; move(m, p, dx * p.spd * dt, dy * p.spd * dt); p.dir = Math.atan2(dy, dx); }
  }
  for (const m of Object.values(r.maps)) {
    const ps = all.filter(p => p.map === m.id); if (!ps.length) continue;
    let en = 0;
    for (const o of m.objs.slice()) {
      if (o.kind === 'enemy') {
        en++; o.cd = Math.max(0, (o.cd || 0) - dt);
        let t = null, bd = 260;
        for (const p of ps) { if (p.dead) continue; const d = Math.hypot(p.x - o.x, p.y - o.y); if (d < bd) { bd = d; t = p; } }
        if (!t) continue;
        if (bd > 26) { const a = Math.atan2(t.y - o.y, t.x - o.x); move(m, o, Math.cos(a) * o.spd * dt, Math.sin(a) * o.spd * dt); }
        else if (o.cd <= 0) { o.cd = 1; hurt(r, t, Math.max(1, Math.round(o.atk * r.diff) - t.def)); }
      } else if (o.kind === 'event') {
        if (o.cd > 0) o.cd -= dt;
        else if (!o.done && o.when === 'enter' && ps.some(p => !p.dead && Math.hypot(p.x - o.x, p.y - o.y) < o.r)) fire(r, m, o);
      }
    }
    if (en > 0) m.seen = true;
    else if (m.seen) { m.seen = false; m.objs.filter(o => o.kind === 'event' && o.when === 'clear' && !o.done).forEach(o => fire(r, m, o)); }
  }
}
const playersPub = (r, id) => inMap(r, id).map(p => ({ id: p.pid, name: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: p.hp, maxhp: p.maxhp, dir: p.dir, dead: p.dead, color: p.color, spr: p.spr }));
// Só os inimigos (que se mexem) vão em todo tick. Os objetos estáticos (cenário, portas, pistas...) só são reenviados quando o mapa muda de versão.
function send(r) {
  const mm = r.maps[r.mview];
  if (r.msid && mm) {
    const k = mm.id + ':' + mm.v, d = { ps: playersPub(r, mm.id), os: mm.objs.filter(isMov) };
    if (r.msv !== k) { r.msv = k; d.st = mm.objs.filter(o => !isMov(o)); d.sid = mm.id; }
    io.to(r.msid).emit('tick', d);
  }
  if (!r.playing) return;
  const cache = {};
  for (const p of Object.values(r.players)) {
    const m = r.maps[p.map];
    if (!p.sid || !p.in || !m) continue;
    const c = cache[p.map] || (cache[p.map] = { ps: playersPub(r, p.map), os: m.objs.filter(isMov).map(pubObj).filter(Boolean), st: null });
    const k = m.id + ':' + m.v, d = { ps: c.ps, os: c.os };
    if (p.sv !== k) { p.sv = k; d.st = c.st || (c.st = m.objs.filter(o => !isMov(o)).map(pubObj).filter(Boolean)); d.sid = m.id; }
    io.to(p.sid).emit('tick', d);
  }
}

const server = http.createServer((q, s) => {
  if (q.url === '/healthz') { s.end('ok'); return; }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(PAGE());
});
const io = new Server(server, { maxHttpBufferSize: 1e6 });

setInterval(() => { for (const r of rooms.values()) { step(r, 0.05); send(r); } }, 50);
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) {
    for (const [pid, p] of Object.entries(r.players)) if (!p.sid && now - (p.off || now) > 120000) { delete r.players[pid]; roster(r); }
    if (!r.msid && !Object.values(r.players).some(p => p.sid)) { r.idle = r.idle || now; if (now - r.idle > 600000) rooms.delete(c); } else r.idle = 0;
  }
}, 5000);

io.on('connection', s => {
  const C = () => { const r = rooms.get(s.data.code); return r ? { r, m: s.id === r.msid, p: r.players[s.data.pid] } : {}; };
  const enter = (r, pid) => { s.data = { code: r.code, pid }; s.join(r.code); r.idle = 0; };
  const initM = r => { r.msv = ''; s.emit('map', mapPub(r.maps[r.mview])); emitMaps(r); s.emit('lib', libOf(r)); s.emit('journal', r.journal); roster(r); };
  const initP = (r, p) => {
    p.off = 0; p.sv = ''; s.emit('me', { at: p.at, spr: p.spr }); s.emit('journal', r.journal);
    if (r.playing) { if (!p.in) spawnP(r, p); else s.emit('map', mapPub(r.maps[p.map] || r.maps[r.start])); }
    roster(r);
  };

  s.on('room:create', (d, cb) => {
    if (rooms.size > 60) return cb({ err: 'Servidor cheio' });
    let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[rnd(23) | 0]).join(''); while (rooms.has(c));
    const r = { code: c, master: uid(), msid: s.id, players: {}, maps: {}, mseq: 1, seq: 1, vseq: 1, msv: '', lib: [], journal: [], playing: false, diff: 1, idle: 0 };
    r.start = r.mview = newMap(r, 'Mapa 1', 'vazio', 40, 28).id;
    rooms.set(c, r); enter(r, r.master);
    cb({ ok: 1, code: c, pid: r.master, role: 'm' }); initM(r);
  });
  s.on('room:join', (d, cb) => {
    const r = rooms.get(str(d && d.code, 4).toUpperCase());
    if (!r) return cb({ err: 'Sala não encontrada' });
    if (Object.keys(r.players).length >= 12) return cb({ err: 'Sala cheia' });
    const pid = uid(), p = newP(r, pid, s.id, str(d.name, 16).trim() || 'Agente', Object.keys(r.players).length);
    r.players[pid] = p; enter(r, pid); cb({ ok: 1, code: r.code, pid, role: 'p' }); initP(r, p);
  });
  s.on('room:rejoin', (d, cb) => {
    const r = rooms.get(d && d.code);
    if (!r) return cb({ err: 'Sala encerrada' });
    if (d.pid === r.master) { r.msid = s.id; enter(r, d.pid); cb({ ok: 1, code: r.code, pid: d.pid, role: 'm' }); return initM(r); }
    const p = r.players[d.pid];
    if (!p) return cb({ err: 'Sessão expirada' });
    p.sid = s.id; enter(r, d.pid); cb({ ok: 1, code: r.code, pid: d.pid, role: 'p' }); initP(r, p);
  });
  s.on('disconnect', () => {
    const { r, m, p } = C(); if (!r) return;
    if (m) r.msid = null; else if (p && p.sid === s.id) { p.sid = null; p.ix = p.iy = 0; p.off = Date.now(); roster(r); }
  });

  // ---- jogador ----
  s.on('attrs', d => {
    const { p } = C(); if (!p || p.in || !d) return;
    const n = {}; let sum = 0;
    for (const k of ['FOR', 'AGI', 'INT', 'PRE', 'VIG']) { n[k] = Math.round(cl(d[k], 0, 5)); sum += n[k]; }
    if (sum > 10) return;
    p.at = n; derive(p); p.hp = p.maxhp; s.emit('me', { at: n, spr: p.spr });
  });
  s.on('look', d => { const { p } = C(); if (p && d && PSPR.includes(d.spr)) { p.spr = d.spr; s.emit('me', { at: p.at, spr: p.spr }); } });
  s.on('input', d => { const { p } = C(); if (p && p.in && d) { p.ix = cl(d.x, -1, 1); p.iy = cl(d.y, -1, 1); } });
  s.on('attack', d => {
    const { r, p } = C(); if (!p || !p.in || p.dead || p.cd > 0) return;
    const m = r.maps[p.map]; if (!m) return;
    p.cd = 0.5; if (d && Number.isFinite(d.a)) p.dir = d.a;
    const ax = p.x + Math.cos(p.dir) * 26, ay = p.y + Math.sin(p.dir) * 26;
    tm(r, m.id, 'fx', { t: 'slash', x: ax, y: ay, a: p.dir });
    for (const o of m.objs.slice()) {
      if (o.kind !== 'enemy' || Math.hypot(o.x - ax, o.y - ay) > 42) continue;
      const dmg = p.atk + (rnd(3) | 0); o.hp -= dmg;
      tm(r, m.id, 'fx', { t: 'dmg', x: o.x, y: o.y, v: dmg, c: '#ffd34d' });
      if (o.hp <= 0) m.objs = m.objs.filter(x => x !== o);
    }
  });
  s.on('interact', () => {
    const { r, p } = C(); if (!p || !p.in || p.dead) return;
    const m = r.maps[p.map]; if (!m) return;
    let b = null, bd = 48;
    for (const o of m.objs) {
      if (o.hidden || !['npc', 'clue', 'door', 'event'].includes(o.kind) || (o.kind === 'event' && (o.when !== 'interact' || o.done || o.cd > 0))) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y); if (d < bd) { bd = d; b = o; }
    }
    if (!b) return;
    if (b.kind === 'npc') s.emit('dialog', { name: b.name, spr: b.spr, lines: b.dialog.length ? b.dialog : ['...'] });
    else if (b.kind === 'clue') { s.emit('dialog', { name: b.name, spr: b.spr, lines: [b.text || '(sem informação)'] }); addJ(r, b.id, b.name, b.text); }
    else if (b.kind === 'event') fire(r, m, b);
    else {
      if (b.locked) return s.emit('toast', 'Está trancada.');
      if (!r.maps[b.to]) return s.emit('toast', 'Esta porta não leva a lugar nenhum.');
      (b.group ? inMap(r, m.id).filter(q => !q.dead) : [p]).forEach(q => goto(r, q, b.to, b.tx, b.ty));
    }
  });

  // ---- mestre ----
  const M = fn => (d, cb) => { const c = C(); if (c.r && c.m) fn(c.r, d, cb, c.r.maps[c.r.mview]); };
  s.on('map:paint', M((r, d, cb, m) => {
    const x = Math.floor(+d.x), y = Math.floor(+d.y), t = Math.floor(cl(d.t, 0, NT - 1));
    if (!(x >= 0 && y >= 0 && x < m.w && y < m.h)) return;
    m.tiles[y * m.w + x] = t; tm(r, m.id, 'tiles', { id: m.id, c: [[x, y, t]] });
  }));
  s.on('map:fill', M((r, d, cb, m) => {
    const x = Math.floor(+d.x), y = Math.floor(+d.y), t = Math.floor(cl(d.t, 0, NT - 1));
    if (!(x >= 0 && y >= 0 && x < m.w && y < m.h)) return;
    const from = m.tiles[y * m.w + x]; if (from === t) return;
    const st = [[x, y]];
    while (st.length) { const [a, b] = st.pop(); if (a < 0 || b < 0 || a >= m.w || b >= m.h || m.tiles[b * m.w + a] !== from) continue; m.tiles[b * m.w + a] = t; st.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]); }
    pushMap(r, m);
  }));
  s.on('map:rect', M((r, d, cb, m) => {
    const t = Math.floor(cl(d.t, 0, NT - 1)), x0 = Math.max(0, Math.floor(Math.min(d.x0, d.x1))), x1 = Math.min(m.w - 1, Math.floor(Math.max(d.x0, d.x1)));
    const y0 = Math.max(0, Math.floor(Math.min(d.y0, d.y1))), y1 = Math.min(m.h - 1, Math.floor(Math.max(d.y0, d.y1)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.tiles[y * m.w + x] = t;
    pushMap(r, m);
  }));
  s.on('map:new', M((r, d) => {
    if (Object.keys(r.maps).length >= 12) return s.emit('toast', 'Limite de 12 mapas.');
    const tpl = ['vazio', 'casa', 'floresta', 'cripta', 'vila', 'cemiterio', 'hospital', 'mansao', 'porao', 'pantano'].includes(d.tpl) ? d.tpl : 'vazio';
    const m = newMap(r, str(d.name, 30).trim() || 'Novo mapa', tpl, Math.floor(cl(d.w, 10, MAXW)), Math.floor(cl(d.h, 10, MAXH)));
    r.mview = m.id; s.emit('map', mapPub(m)); emitMaps(r);
  }));
  s.on('map:edit', M((r, d, cb, m) => {
    const w = Math.floor(cl(d.w, 10, MAXW)), h = Math.floor(cl(d.h, 10, MAXH)), t = new Array(w * h).fill(0);
    for (let y = 0; y < Math.min(h, m.h); y++) for (let x = 0; x < Math.min(w, m.w); x++) t[y * w + x] = m.tiles[y * m.w + x];
    m.tiles = t; m.w = w; m.h = h; m.name = str(d.name, 30).trim() || m.name;
    m.objs = m.objs.filter(o => o.x < w * TS && o.y < h * TS); dirty(r, m);
    inMap(r, m.id).forEach(p => { p.x = Math.min(p.x, w * TS - 20); p.y = Math.min(p.y, h * TS - 20); });
    pushMap(r, m); emitMaps(r); roster(r);
  }));
  s.on('map:del', M((r, d, cb, m) => {
    if (Object.keys(r.maps).length <= 1 || m.id === r.start) return s.emit('toast', 'Não dá para excluir o mapa inicial.');
    delete r.maps[m.id];
    Object.values(r.maps).forEach(x => x.objs.forEach(o => { if (o.kind === 'door' && o.to === m.id) { o.to = ''; dirty(r, x); } }));
    Object.values(r.players).forEach(p => { if (p.map === m.id) { if (p.in) goto(r, p, r.start, -1, -1); else p.map = r.start; } });
    r.mview = r.start; s.emit('map', mapPub(r.maps[r.start])); emitMaps(r); roster(r);
  }));
  s.on('map:start', M((r, d, cb, m) => { r.start = m.id; emitMaps(r); s.emit('toast', '"' + m.name + '" é o mapa inicial.'); }));
  s.on('map:view', M((r, d) => { if (d && r.maps[d.id]) { r.mview = d.id; s.emit('map', mapPub(r.maps[d.id])); emitMaps(r); } }));

  s.on('obj:put', M((r, d, cb, m) => {
    if (!d || !d.obj) return;
    const old = d.obj.id && m.objs.find(o => o.id === d.obj.id);
    const n = old ? clean(d.obj, old) : addObj(r, m, d.obj);
    if (old) dirty(r, m);
    if (n && n.kind === 'door' && d.obj.back && r.maps[n.to]) { // cria a porta de volta no mapa de destino
      const dm = r.maps[n.to], sp = dm.objs.find(o => o.kind === 'spawn');
      addObj(r, dm, {
        kind: 'door', name: 'Porta de volta', spr: n.solid ? 'porta' : n.spr, group: n.group, to: m.id, tx: Math.floor(n.x / TS), ty: Math.floor(n.y / TS) + (n.solid ? 1 : 0),
        x: n.tx >= 0 ? (n.tx + .5) * TS : sp ? sp.x : dm.w * TS / 2, y: n.ty >= 0 ? (n.ty + .5) * TS : sp ? sp.y - TS : dm.h * TS / 2
      });
    }
  }));
  s.on('obj:del', M((r, id, cb, m) => { m.objs = m.objs.filter(o => o.id !== id); dirty(r, m); }));
  s.on('game:start', M(r => {
    r.playing = true;
    Object.values(r.maps).forEach(m => { m.seen = false; m.objs.forEach(o => { if (o.kind === 'event') { o.done = false; o.cd = 0; } }); dirty(r, m); });
    Object.values(r.players).forEach(p => spawnP(r, p)); roster(r);
  }));
  s.on('game:stop', M(r => {
    r.playing = false;
    Object.values(r.players).forEach(p => { p.in = false; p.hp = p.maxhp; p.dead = false; p.map = r.start; if (p.sid) io.to(p.sid).emit('stop'); });
    roster(r);
  }));
  s.on('heal', M(r => { Object.values(r.players).forEach(p => { p.hp = p.maxhp; p.dead = false; }); io.to(r.code).emit('toast', 'O grupo foi restaurado.'); }));
  s.on('say', M((r, t) => io.to(r.code).emit('toast', str(t, 200))));
  s.on('diff', M((r, v) => { r.diff = cl(v, 0.5, 3); }));
  s.on('lib:save', M((r, d) => {
    if (r.lib.length >= 40 || !d || !d.obj) return;
    const n = clean(Object.assign({}, d.obj, { x: 0, y: 0 })); if (!n) return;
    delete n.done; n.id = 'c' + r.seq++; r.lib.push(n); s.emit('lib', libOf(r));
  }));
  s.on('camp:export', M((r, d, cb) => cb && cb(JSON.stringify({ v: 2, start: r.start, maps: Object.values(r.maps).map(m => ({ id: m.id, name: m.name, w: m.w, h: m.h, tiles: m.tiles, objs: m.objs })), lib: r.lib }))));
  s.on('camp:import', M((r, d, cb) => {
    try {
      const j = JSON.parse(d);
      if (!Array.isArray(j.maps) || !j.maps.length || j.maps.length > 12) throw 0;
      const maps = {}, ids = new Set(); let mseq = 1;
      for (const x of j.maps) {
        const w = Math.floor(cl(x.w, 10, MAXW)), h = Math.floor(cl(x.h, 10, MAXH));
        if (!/^m\d{1,4}$/.test(x.id) || maps[x.id] || !Array.isArray(x.tiles) || x.tiles.length !== w * h) throw 0;
        const m = { id: x.id, name: str(x.name, 30), w, h, tiles: x.tiles.map(t => Math.floor(cl(t, 0, NT - 1))), objs: [], seen: false };
        for (const o of (x.objs || []).slice(0, 500)) {
          const n = clean(o); if (!n) continue;
          n.x = cl(n.x, 0, w * TS); n.y = cl(n.y, 0, h * TS);
          n.id = /^o\d{1,6}$/.test(o.id) && !ids.has(o.id) ? o.id : null; if (n.id) ids.add(n.id);
          m.objs.push(n);
        }
        maps[x.id] = m; mseq = Math.max(mseq, +x.id.slice(1) + 1);
      }
      let seq = 1; ids.forEach(i => { seq = Math.max(seq, +i.slice(1) + 1); });
      Object.values(maps).forEach(m => m.objs.forEach(o => { if (!o.id) o.id = 'o' + seq++; }));
      Object.values(maps).forEach(m => dirty(r, m));
      r.maps = maps; r.mseq = mseq; r.seq = seq; r.start = maps[j.start] ? j.start : Object.keys(maps)[0]; r.mview = r.start;
      r.lib = []; (j.lib || []).slice(0, 40).forEach(o => { const n = clean(o); if (n) { n.id = 'c' + r.seq++; r.lib.push(n); } });
      r.journal = []; io.to(r.code).emit('journal', []);
      Object.values(r.players).forEach(p => { if (p.in) goto(r, p, r.start, -1, -1); else p.map = r.start; });
      s.emit('map', mapPub(r.maps[r.mview])); emitMaps(r); s.emit('lib', libOf(r)); roster(r);
      cb && cb({ ok: 1 });
    } catch (e) { cb && cb({ err: 'Arquivo inválido' }); }
  }));
});

server.listen(PORT, '0.0.0.0', () => console.log('Engine Paranormal na porta ' + PORT));

// ================= CLIENTE (página única) =================
function PAGE() { return String.raw`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Engine Paranormal</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#08070c;color:#e6e1d8;font:14px/1.4 'Trebuchet MS',system-ui,sans-serif;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}
[hidden]{display:none!important}img{image-rendering:pixelated}
input,select,textarea,button{font:inherit;color:inherit;background:#17141f;border:1px solid #3b3350;border-radius:4px;padding:7px;min-width:0}
textarea{width:100%;height:58px;user-select:text}input{user-select:text}
button{cursor:pointer;background:#241a30}button:active,button.on{background:#8a1c2c;border-color:#c8394d}
h1{font:italic 700 26px Georgia,serif;letter-spacing:.04em;margin:0;color:#d23a4c}
.screen{display:flex;flex-direction:column;gap:10px;max-width:340px;margin:10vh auto;padding:20px}
.screen small{color:#8d86a0}#err{color:#ff7b8a;min-height:1.2em}
#cv{position:fixed;inset:0;width:100%;height:100%}
#hud{position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;display:flex;gap:8px;padding:8px;pointer-events:none;align-items:center}
#hud>*{pointer-events:auto}#code,#mn,#cell{background:#17141f;padding:4px 8px;border-radius:4px}#code{font:700 16px monospace;letter-spacing:.2em}#cell{font:12px monospace}
#hpb{width:120px;height:10px;background:#300;border-radius:5px;overflow:hidden}#hpf{height:100%;background:#d23a4c;width:100%}
#toast{position:fixed;top:56px;left:50%;transform:translateX(-50%);background:#000c;border:1px solid #8a1c2c;padding:8px 14px;border-radius:4px;max-width:80vw;text-align:center;opacity:0;transition:opacity .3s;pointer-events:none;z-index:9}
#wait{position:fixed;inset:0;background:#08070c;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;padding:20px;text-align:center;overflow:auto}
#atb div{display:flex;gap:8px;align-items:center;justify-content:center;margin:3px}#atb b{width:36px;text-align:left}
#sps{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}#sps button{padding:4px}#sps img{width:48px;height:48px;display:block}
#dlg,#jr{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(120px + env(safe-area-inset-bottom,0));width:min(92vw,520px);background:#0d0a12f2;border:1px solid #8a1c2c;border-radius:6px;padding:12px;overflow:hidden}
#dlg p{font:italic 16px Georgia,serif;margin:8px 0}#dlg img{float:left;margin-right:10px;width:56px;height:56px}#jr{bottom:auto;top:56px;max-height:60vh;overflow:auto}
#mp{position:fixed;right:0;top:0;bottom:0;width:310px;background:#0d0a12f5;border-left:1px solid #3b3350;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;padding-top:48px}
#mp label{display:block;font-size:12px;color:#a69fba;margin-top:4px}#mp label input:not([type=checkbox]),#mp label select{width:100%}
#tools,#tiles,#ses,.g{display:flex;flex-wrap:wrap;gap:5px}#tools button{flex:1;font-size:17px;padding:5px}
#tiles button{width:36px;height:36px;padding:0;background-size:cover}.g button{padding:2px}.g img{width:36px;height:36px;display:block;object-fit:contain}#gal summary{cursor:pointer;color:#a69fba;font-size:12px;padding:5px 0;border-top:1px solid #2a2438}#gq{width:100%;margin:2px 0 6px}#gsel{margin:4px 0}.pv{width:40px;height:40px;vertical-align:middle;margin-right:6px;object-fit:contain}
.ac{border:1px solid #3b3350;border-radius:4px;padding:6px;margin-top:6px}.rm{float:right;padding:2px 8px}
#mform{border:1px solid #3b3350;border-radius:4px;padding:6px}
#mt{position:fixed;right:8px;top:calc(8px + env(safe-area-inset-top,0));z-index:5}
#touch{display:none}
@media(pointer:coarse){#touch:not([hidden]){display:block}}
#joy{position:fixed;left:24px;bottom:calc(24px + env(safe-area-inset-bottom,0));width:120px;height:120px;border-radius:50%;background:#ffffff14;border:1px solid #fff3;touch-action:none}
#knob{position:absolute;left:40px;top:40px;width:40px;height:40px;border-radius:50%;background:#d23a4ccc}
#bA,#bE{position:fixed;right:24px;width:68px;height:68px;border-radius:50%;font-size:26px;bottom:calc(24px + env(safe-area-inset-bottom,0))}#bE{right:104px;bottom:calc(44px + env(safe-area-inset-bottom,0));width:52px;height:52px}
@media(max-width:700px){#mp{top:auto;left:0;width:auto;max-height:50vh;border-left:0;border-top:1px solid #3b3350;padding-top:8px}#mp.c>*{display:none}}
</style></head><body>
<div id="home" class="screen"><h1>Engine Paranormal</h1><small>RPG de ação cooperativo com mestre e editor de campanha.</small>
<input id="nm" maxlength="16" placeholder="Seu nome"><button id="bc">Criar sala como mestre</button>
<small>ou entre numa sala existente</small><input id="cd" maxlength="4" placeholder="Código da sala" style="text-transform:uppercase"><button id="bj">Entrar na sala</button><div id="err"></div></div>
<div id="game" hidden><canvas id="cv"></canvas>
<div id="hud"><span id="code"></span><span id="mn"></span><div id="hpb"><div id="hpf"></div></div><span id="cell"></span><button id="bjr">📖</button></div>
<div id="toast"></div>
<div id="wait"><h1>Aguardando o mestre</h1><div>Sala <b id="code2"></b></div><div id="ros"></div><small>Escolha seu personagem:</small><div id="sps"></div><small>Distribua 10 pontos de atributo:</small><div id="atb"></div><small id="der"></small></div>
<div id="dlg" hidden></div><div id="jr" hidden></div>
<div id="touch" hidden><div id="joy"><i id="knob"></i></div><button id="bE">💬</button><button id="bA">⚔️</button></div>
<button id="mt" hidden>☰</button>
<div id="mp" hidden>
<div style="display:flex;gap:6px"><select id="maps" style="flex:1"></select><button id="bmg" title="Editar/criar mapas">⚙</button><button id="bst" title="Definir como mapa inicial">🏁</button></div>
<div id="mform" hidden><label>Nome<input id="mnm" maxlength="30"></label><div style="display:flex;gap:6px"><label>Largura<input id="mw" type="number" min="10" max="80"></label><label>Altura<input id="mh" type="number" min="10" max="60"></label></div>
<label>Cenário base (ao criar)<select id="mtpl"><option value="vazio">Campo aberto</option><option value="casa">Casa com cômodos</option><option value="floresta">Floresta com trilha</option><option value="cripta">Cripta com círculo ritual</option><option value="vila">Vila com rua e casas</option><option value="cemiterio">Cemitério com mausoléu</option><option value="hospital">Hospital abandonado</option><option value="mansao">Mansão com cômodos</option><option value="porao">Porão ritual</option><option value="pantano">Pântano com passarela</option></select></label>
<div style="display:flex;gap:6px;margin-top:6px"><button id="mnew" style="flex:1">Criar novo mapa</button><button id="msave">Salvar</button><button id="mdel">Excluir</button></div></div>
<div id="tools"><button data-t="hand" title="Mover câmera">🖐</button><button data-t="sel" title="Selecionar/editar">✏️</button><button data-t="paint" title="Pincel">🖌</button><button data-t="fill" title="Balde">🪣</button><button data-t="rect" title="Retângulo">▭</button><button data-t="place" title="Colocar">➕</button><button data-t="del" title="Apagar">🗑</button></div>
<div id="tiles" hidden></div><div id="gal" hidden><input id="gq" placeholder="Buscar item…" autocomplete="off"><div id="gsel"></div><div id="gl"></div></div>
<div id="insp"></div>
<div id="ses"><button id="go" style="flex:1">▶ Iniciar sessão</button><button id="heal">✚ Curar</button></div>
<label>Dificuldade dos inimigos <input id="diff" type="range" min="0.5" max="3" step="0.25" value="1" style="width:100%"></label>
<div style="display:flex;gap:6px"><input id="say" placeholder="Mensagem para todos" style="flex:1"><button id="bsay">📣</button></div>
<div style="display:flex;gap:6px"><button id="exp" style="flex:1">💾 Exportar</button><button id="imp" style="flex:1">📂 Importar</button></div><input id="file" type="file" hidden>
<small id="ros2"></small></div></div>
<script src="/socket.io/socket.io.js"></script><script>
const $=i=>document.getElementById(i),TS=32;
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// ---------- sprites (pixel art em grade 16x16, desenhados por código) ----------
const SPR={},DU={};
function mk(id,n,cat,f,tw,th){tw=tw||1;th=th||1;const c=document.createElement('canvas');c.width=tw*32;c.height=th*32;const x=c.getContext('2d');
 const R=(a,b,w,h,col)=>{if(col==='clear')x.clearRect(a*2,b*2,w*2,h*2);else{x.fillStyle=col;x.fillRect(a*2,b*2,w*2,h*2)}};
 R.o=(cx,cy,rx,ry,col)=>{x.fillStyle=col;x.beginPath();x.ellipse(cx*2,cy*2,rx*2,ry*2,0,0,7);x.fill()};
 R.r=(cx,cy,rx,ry,t,col)=>{x.strokeStyle=col;x.lineWidth=t*2;x.beginPath();x.ellipse(cx*2,cy*2,rx*2,ry*2,0,0,7);x.stroke()};
 R.l=(x1,y1,x2,y2,t,col)=>{x.strokeStyle=col;x.lineWidth=t*2;x.beginPath();x.moveTo(x1*2,y1*2);x.lineTo(x2*2,y2*2);x.stroke()};
 f(R);SPR[id]={n:n,cat:cat,img:c,tw:tw,th:th,flat:cat==='Chão'}}
const url=id=>DU[id]||(DU[id]=SPR[id]?SPR[id].img.toDataURL():'');
function hum(id,n,o){mk(id,n,o.cat||'Pessoas',R=>{
 R(5,12,2,3,o.pants);R(9,12,2,3,o.pants);R(4,15,3,1,'#111');R(9,15,3,1,'#111');
 R(4,7,8,5,o.shirt);R(3,8,1,4,o.shirt);R(12,8,1,4,o.shirt);R(3,12,1,1,o.skin);R(12,12,1,1,o.skin);
 if(o.robe){R(3,6,10,9,o.robe);R(5,15,6,1,o.robe)}
 R(5,2,6,5,o.skin);R(5,1,6,2,o.hair);if(o.long){R(4,2,1,5,o.hair);R(11,2,1,5,o.hair)}
 if(o.hood){R(4,1,8,7,o.hood);R(6,3,4,4,o.skin)}
 R(6,4,1,1,o.eye||'#111');R(9,4,1,1,o.eye||'#111');
 if(o.hat){R(4,1,8,2,o.hat);R(3,3,10,1,o.hat)}
 if(o.mask)R(6,5,4,2,o.mask);
 if(o.ribs){R(6,8,4,1,'#555');R(6,10,4,1,'#555')}})}
hum('investigador','Investigador',{skin:'#e0b08a',hair:'#4a3020',shirt:'#b08a5a',pants:'#3a3a50'});
hum('ocultista','Ocultista',{skin:'#d9b08c',hair:'#222',shirt:'#3a2a5a',pants:'#222',robe:'#3a2a5a',hood:'#3a2a5a'});
hum('soldado','Soldado',{skin:'#c99a74',hair:'#222',shirt:'#4a5a3a',pants:'#3a4530',hat:'#3a4530'});
hum('medica','Médica',{skin:'#f0c8a8',hair:'#b4501e',long:1,shirt:'#eee',pants:'#4a6a8a'});
hum('policial','Policial',{skin:'#a8704a',hair:'#111',shirt:'#2a3f6a',pants:'#1e2a44',hat:'#1e2a44'});
hum('aldeao','Sobrevivente',{skin:'#e0b08a',hair:'#8a7a50',shirt:'#6a5040',pants:'#4a4030'});
hum('padre','Padre',{skin:'#e8c4a0',hair:'#ccc',shirt:'#111',pants:'#111',robe:'#111'});
hum('cultista','Cultista',{skin:'#d9b08c',hair:'#222',shirt:'#7a1020',pants:'#222',robe:'#7a1020',hood:'#7a1020',mask:'#ddd',eye:'#f33',cat:'Criaturas'});
hum('zumbi','Zumbi',{skin:'#8fae6a',hair:'#2a2a1a',shirt:'#5a4a3a',pants:'#3a3a4a',eye:'#c22',cat:'Criaturas'});
hum('esqueleto','Esqueleto',{skin:'#e8e4d0',hair:'#e8e4d0',shirt:'#e8e4d0',pants:'#e8e4d0',eye:'#000',ribs:1,cat:'Criaturas'});
mk('sombra','Sombra','Criaturas',R=>{const k='#15101f';R(4,3,8,9,k);R(3,6,10,6,k);R(3,12,2,2,k);R(7,12,2,3,k);R(11,12,2,2,k);R(5,5,2,2,'#f22');R(9,5,2,2,'#f22')});
mk('criatura','Criatura','Criaturas',R=>{const k='#6a2a7a';R(3,5,10,8,k);R(4,3,8,3,k);R(2,13,2,2,k);R(6,13,2,3,k);R(10,13,2,3,k);R(13,11,1,4,k);R(5,5,2,2,'#ff0');R(9,5,2,2,'#ff0');R(7,8,2,2,'#ff0');R(5,11,6,1,'#200')});
mk('cao','Cão infernal','Criaturas',R=>{const k='#3a2a2a';R(2,7,10,4,k);R(10,5,4,4,k);R(13,6,2,2,'#222');R(11,6,1,1,'#f33');R(3,11,2,3,k);R(6,11,2,3,k);R(9,11,2,3,k);R(1,6,2,1,k);R(11,4,1,2,k)});
mk('olho','Olho flutuante','Criaturas',R=>{R(4,4,8,8,'#eee');R(3,5,10,6,'#eee');R(6,6,4,4,'#c22');R(7,7,2,2,'#000');R(4,5,1,1,'#c44');R(11,9,1,1,'#c44')});
mk('caixa','Caixote','Cenário',R=>{R(3,5,10,9,'#8a5a2a');R(3,5,10,1,'#a87a3a');R(3,9,10,1,'#6a4220');R(7,5,2,9,'#6a4220')});
mk('barril','Barril','Cenário',R=>{R(4,4,8,10,'#7a4a20');R(4,6,8,1,'#444');R(4,11,8,1,'#444');R(5,3,6,1,'#9a6a30')});
mk('bau','Baú','Cenário',R=>{R(2,7,12,7,'#7a4a20');R(2,5,12,3,'#8a5a2a');R(2,9,12,1,'#d4a020');R(7,8,2,3,'#d4a020')});
mk('mesa','Mesa','Cenário',R=>{R(2,6,12,3,'#8a5a2a');R(3,9,2,5,'#6a4220');R(11,9,2,5,'#6a4220')});
mk('cama','Cama','Cenário',R=>{R(2,5,12,9,'#6a4220');R(3,6,10,7,'#c8c8d8');R(3,6,4,3,'#fff');R(3,10,10,3,'#8a2030')});
mk('estante','Estante','Cenário',R=>{R(3,1,10,14,'#5a3a1a');[2,6,10].forEach(y=>{R(4,y,8,3,'#2a1a0a');R(4,y,1,3,'#a33');R(6,y,1,3,'#38a');R(8,y,1,3,'#3a3');R(10,y,2,3,'#aa3')})});
mk('arvore','Árvore','Cenário',R=>{R(7,9,2,6,'#5a3a1a');R(3,2,10,8,'#245a2a');R(2,4,12,4,'#2e7034');R(5,1,6,2,'#2e7034')});
mk('lapide','Lápide','Cenário',R=>{R(4,4,8,10,'#8a8a94');R(5,3,6,1,'#8a8a94');R(7,6,2,5,'#555');R(6,8,4,1,'#555');R(3,13,10,2,'#4a5a3a')});
mk('tocha','Tocha','Cenário',R=>{R(7,6,2,8,'#6a4220');R(6,2,4,5,'#f90');R(7,1,2,3,'#ff6')});
mk('altar','Altar','Cenário',R=>{R(2,7,12,7,'#4a4a56');R(3,5,10,3,'#6a6a78');R(6,3,4,2,'#c22');R(3,3,1,2,'#fe8');R(12,3,1,2,'#fe8')});
mk('papel','Bilhete','Pistas',R=>{R(4,3,8,10,'#e8e0c0');R(5,5,6,1,'#777');R(5,7,6,1,'#777');R(5,9,4,1,'#777')});
mk('diario','Diário','Pistas',R=>{R(3,3,10,10,'#4a2a2a');R(4,4,1,8,'#2a1010');R(6,6,5,1,'#caa');R(6,8,4,1,'#caa')});
mk('chave','Chave','Pistas',R=>{R(3,6,4,4,'#e8c040');R(4,7,2,2,'#4a3000');R(7,7,7,2,'#e8c040');R(11,9,1,2,'#e8c040');R(13,9,1,2,'#e8c040')});
mk('porta','Porta','Portas',R=>{R(4,1,8,14,'#6a4220');R(5,2,6,12,'#8a5a2a');R(9,8,1,2,'#d4a020');R(4,1,8,1,'#4a2a10')});
mk('escada','Escada','Portas',R=>{R(3,2,10,1,'#111');['#555','#666','#777','#888','#999'].forEach((c,i)=>R(3,3+i*2,10,2,c))});
mk('portal','Portal','Portas',R=>{R(4,2,8,12,'#7a2aaa');R(5,3,6,10,'#c070ff');R(7,5,2,6,'#fff')});
mk('runa','Gatilho (runa)','Eventos',R=>{const k='#d4c030';R(4,4,8,1,k);R(4,11,8,1,k);R(4,4,1,8,k);R(11,4,1,8,k);R(7,6,2,4,k)});
mk('alavanca','Alavanca','Eventos',R=>{R(4,11,8,3,'#555');R(7,5,2,7,'#aaa');R(6,3,4,3,'#d22')});
mk('bandeira','Início','Eventos',R=>{R(4,2,1,13,'#ddd');R(5,2,7,5,'#2a8a2a')});
// ===== CATÁLOGO ESTENDIDO DE SPRITES (grade 16x16 por célula; sprites grandes ocupam tw x th células) =====
const wd1='#8a5a2a',wd2='#6a4220',wd3='#a87a3a',wd4='#5a3a1a',st1='#6a6a78',st2='#4a4a56',st3='#8a8a94',mt='#aab',md='#555',bk='#111',rd='#a22',gn='#2e7034',gn2='#245a2a',wh='#eee',yl='#e8c040',og='#f90',bl='#38a',bl2='#7ab8d8',pu='#7a2aaa',pp='#e8e0c0',bd='#7a0d14';
// Pessoas
hum('detetive','Detetive',{skin:'#e0b08a',hair:'#3a2a1a',shirt:'#7a6a50',pants:'#2a2a30',hat:'#5a4a30'});
hum('jornalista','Jornalista',{skin:'#d9b08c',hair:'#8a3a1a',long:1,shirt:'#3a6a5a',pants:'#3a3a4a'});
hum('cientista','Cientista',{skin:'#e8c4a0',hair:'#ddd',shirt:'#f4f4f4',pants:'#3a3a50',robe:'#f0f0f0'});
hum('medico','Médico',{skin:'#c99a74',hair:'#222',shirt:'#8ac',pants:'#8ac',mask:'#bde'});
hum('delegado','Delegado',{skin:'#e0b08a',hair:'#999',shirt:'#2a3f6a',pants:'#1e2a44',hat:'#111'});
hum('mendigo','Mendigo',{skin:'#b08a6a',hair:'#4a4a3a',shirt:'#5a5a4a',pants:'#3a3a30',robe:'#4a4a3a'});
hum('fazendeiro','Fazendeiro',{skin:'#d9a67a',hair:'#6a4a2a',shirt:'#8a3a2a',pants:'#3a4a7a',hat:'#d4b060'});
hum('velha','Senhora idosa',{skin:'#e8c4a0',hair:'#eee',long:1,shirt:'#7a5a8a',pants:'#5a4a6a'});
hum('guarda','Guarda',{skin:'#a8704a',hair:'#111',shirt:'#333',pants:'#222',hat:'#222'});
hum('comerciante','Comerciante',{skin:'#d9b08c',hair:'#5a3a1a',shirt:'#3a6a3a',pants:'#4a3a2a'});
hum('cozinheira','Cozinheira',{skin:'#e0b08a',hair:'#2a1a0a',shirt:'#fff',pants:'#555',hat:'#fff'});
// Criaturas
hum('possuido','Possuído',{skin:'#a8a8b8',hair:'#111',shirt:'#3a3a4a',pants:'#222',eye:'#f0f',cat:'Criaturas'});
hum('carnical','Carniçal',{skin:'#7a8a7a',hair:'#222',shirt:'#4a3a3a',pants:'#2a2a2a',eye:'#ff0',ribs:1,cat:'Criaturas'});
hum('mumia','Múmia',{skin:'#d8cfa8',hair:'#d8cfa8',shirt:'#d8cfa8',pants:'#d8cfa8',eye:'#c22',cat:'Criaturas'});
mk('aranha','Aranha gigante','Criaturas',R=>{const k='#241a2a';R(5,6,6,5,k);R(6,4,4,3,k);[[1,5],[1,8],[2,11],[11,5],[11,8],[11,11]].forEach(g=>R(g[0],g[1],4,1,k));R(3,4,2,1,k);R(11,4,2,1,k);R(6,5,1,1,'#f33');R(9,5,1,1,'#f33');R(7,8,2,1,rd)});
mk('morcego','Morcego','Criaturas',R=>{const k='#2a2034';R(6,5,4,6,k);R(7,3,1,2,k);R(9,3,1,2,k);R(1,5,5,3,k);R(0,7,3,3,k);R(10,5,5,3,k);R(13,7,3,3,k);R(2,8,3,1,k);R(11,8,3,1,k);R(7,6,1,1,'#f33');R(9,6,1,1,'#f33')});
mk('rato','Rato','Criaturas',R=>{const k='#7a6a5a';R(3,9,8,4,k);R(10,8,4,4,k);R(13,10,2,1,'#222');R(10,6,2,2,'#c99');R(1,12,3,1,'#c99');R(3,13,2,1,k);R(9,13,2,1,k);R(12,9,1,1,'#f33')});
mk('corvo','Corvo','Criaturas',R=>{const k='#15151c';R(4,6,8,6,k);R(10,3,4,4,k);R(14,5,2,1,og);R(12,4,1,1,wh);R(2,8,3,2,k);R(5,12,1,3,'#654');R(9,12,1,3,'#654')});
mk('fantasma','Fantasma','Criaturas',R=>{const k='#cfe0ee';R(4,3,8,10,k);R(3,5,10,8,k);R(3,13,2,2,k);R(7,13,2,2,k);R(11,13,2,2,k);R(5,6,2,3,'#223');R(9,6,2,3,'#223');R(7,10,2,2,'#223')});
mk('lobo','Lobo','Criaturas',R=>{const k='#6a6a74';R(2,7,10,4,k);R(10,5,4,4,k);R(13,7,2,2,'#333');R(11,6,1,1,'#fd3');R(3,11,2,3,k);R(6,11,2,3,k);R(9,11,2,3,k);R(1,6,2,2,k);R(11,3,1,2,k);R(13,3,1,2,k);R(3,7,8,1,st3)});
mk('demonio','Demônio','Criaturas',R=>{const k='#8a1a1a';R(4,5,8,8,k);R(5,3,6,3,k);R(4,1,1,3,'#222');R(11,1,1,3,'#222');R(1,4,3,5,'#5a1010');R(12,4,3,5,'#5a1010');R(4,13,3,2,k);R(9,13,3,2,k);R(6,4,1,1,'#ff0');R(9,4,1,1,'#ff0');R(6,8,4,1,'#200')});
mk('tentaculo','Tentáculo','Criaturas',R=>{const k='#4a6a3a';R(6,6,4,9,k);R(5,3,3,4,k);R(3,1,3,3,k);R(9,4,3,3,k);R(11,2,3,3,k);R(5,12,6,3,'#3a5a2a');R(7,8,1,1,'#c8d070');R(7,10,1,1,'#c8d070')});
mk('boneca','Boneca amaldiçoada','Criaturas',R=>{R(5,3,6,6,'#f0d8c8');R(4,2,8,3,'#222');R(4,4,1,5,'#222');R(11,4,1,5,'#222');R(4,9,8,5,'#7a1a3a');R(5,14,2,1,'#f0d8c8');R(9,14,2,1,'#f0d8c8');R(6,5,1,2,bk);R(9,5,1,2,bk);R(7,8,2,1,rd)});
mk('vulto','Vulto','Criaturas',R=>{const k='#0a0a12';R(6,0,4,13,k);R(5,2,6,8,k);R(2,4,3,1,k);R(11,4,3,1,k);R(2,4,1,6,k);R(13,4,1,6,k);R(7,13,2,2,k);R(6,3,1,1,wh);R(9,3,1,1,wh)});
mk('larva','Larva gigante','Criaturas',R=>{const k='#c8b88a';R(1,9,4,4,k);R(4,8,4,5,'#b8a87a');R(7,8,4,5,k);R(10,9,4,4,'#b8a87a');R(12,8,3,4,'#8a6a4a');R(13,9,1,1,bk)});
mk('gosma','Gosma','Criaturas',R=>{const k='#4aaa4a';R(3,8,10,6,k);R(4,6,8,3,k);R(5,5,4,2,'#7ada7a');R(5,8,2,2,bk);R(9,8,2,2,bk);R(5,8,1,1,wh);R(9,8,1,1,wh)});
// Móveis
mk('sofa','Sofá','Móveis',R=>{R(1,4,30,4,'#6a2028');R(1,7,30,7,'#7a2a30');R(0,5,3,9,'#5a1a22');R(29,5,3,9,'#5a1a22');R(3,13,2,2,wd4);R(27,13,2,2,wd4);R(12,8,1,5,'#5a1a22');R(20,8,1,5,'#5a1a22')},2,1);
mk('poltrona','Poltrona','Móveis',R=>{R(3,3,10,5,'#2e4a68');R(3,7,10,7,'#3a5a7a');R(2,6,2,8,'#2e4a68');R(12,6,2,8,'#2e4a68');R(4,13,2,2,wd4);R(10,13,2,2,wd4)});
mk('cadeira','Cadeira','Móveis',R=>{R(4,2,8,6,wd1);R(5,3,6,3,wd2);R(4,8,8,2,wd3);R(4,10,2,5,wd2);R(10,10,2,5,wd2)});
mk('banco','Banco','Móveis',R=>{R(2,8,12,2,wd3);R(2,10,12,1,wd2);R(3,11,2,4,wd2);R(11,11,2,4,wd2)});
mk('cadeira_balanco','Cadeira de balanço','Móveis',R=>{R(4,2,2,9,wd1);R(4,2,8,2,wd1);R(4,8,9,2,wd3);R(11,6,2,3,wd1);R(2,12,12,1,wd2);R(1,13,2,1,wd2);R(13,13,2,1,wd2)});
mk('mesa_longa','Mesa longa','Móveis',R=>{R(2,6,28,4,wd1);R(2,6,28,1,wd3);R(3,10,2,5,wd2);R(27,10,2,5,wd2);R(8,5,3,1,wh);R(21,5,3,1,wh);R(15,3,2,3,wh);R(15,2,2,1,og)},2,1);
mk('mesa_redonda','Mesa redonda','Móveis',R=>{R(4,6,8,1,wd3);R(3,7,10,3,wd3);R(4,10,8,1,wd1);R(7,11,2,4,wd2);R(5,14,6,1,wd2)});
mk('escrivaninha','Escrivaninha','Móveis',R=>{R(1,6,14,3,wd1);R(1,6,14,1,wd3);R(1,9,3,6,wd2);R(12,9,3,6,wd2);R(4,5,4,1,pp);R(10,3,3,3,bl);R(11,2,1,1,yl)});
mk('cama_casal','Cama de casal','Móveis',R=>{R(1,3,30,12,wd2);R(2,4,28,10,'#c8c8d8');R(3,5,8,4,wh);R(13,5,8,4,wh);R(2,10,28,4,'#2a4a7a');R(2,10,28,1,'#3a5a8a')},2,1);
mk('beliche','Beliche','Móveis',R=>{R(2,1,12,14,wd2);R(3,2,10,5,'#c8c8d8');R(3,9,10,5,'#c8c8d8');R(3,2,4,2,wh);R(3,9,4,2,wh);R(2,7,12,1,wd1);R(11,3,1,10,wd1)});
mk('berco','Berço','Móveis',R=>{R(3,6,10,8,wd3);R(3,5,10,1,wd1);R(4,7,1,6,wh);R(7,7,1,6,wh);R(10,7,1,6,wh);R(12,7,1,6,wh);R(5,10,6,3,'#bcd')});
mk('armario','Armário','Móveis',R=>{R(3,1,10,14,wd4);R(4,2,4,12,wd1);R(8,2,4,12,wd1);R(7,7,1,2,yl);R(8,7,1,2,yl)});
mk('comoda','Cômoda','Móveis',R=>{R(2,5,12,10,wd1);R(2,5,12,1,wd3);R(3,6,10,4,wd2);R(3,10,10,4,wd2);R(7,8,2,1,yl);R(7,12,2,1,yl)});
mk('criado_mudo','Criado-mudo','Móveis',R=>{R(4,8,8,7,wd1);R(5,10,6,3,wd2);R(7,11,2,1,yl);R(6,5,4,3,yl);R(7,8,2,1,md)});
mk('espelho_pe','Espelho de chão','Móveis',R=>{R(4,1,8,14,wd4);R(5,2,6,12,'#9cc8d8');R(6,3,1,6,wh);R(5,14,6,1,wd4)});
mk('lareira','Lareira','Móveis',R=>{R(2,2,12,13,st1);R(2,2,12,2,st3);R(5,6,6,9,bk);R(6,10,4,5,og);R(7,9,2,3,'#ff6');R(2,14,12,1,st2)});
mk('fogao','Fogão a lenha','Móveis',R=>{R(6,0,4,4,md);R(3,3,10,12,'#444');R(3,3,10,1,'#777');R(4,6,8,5,bk);R(5,8,6,2,og);R(4,12,8,1,'#666')});
mk('geladeira','Geladeira','Móveis',R=>{R(4,1,8,14,'#dde');R(4,6,8,1,'#99a');R(10,3,1,2,'#667');R(10,8,1,3,'#667');R(4,14,8,1,'#99a')});
mk('pia','Pia','Móveis',R=>{R(2,8,12,7,'#ddd');R(3,9,10,3,'#8ac');R(7,5,2,3,mt);R(6,5,4,1,mt);R(2,14,12,1,mt)});
mk('banheira','Banheira','Móveis',R=>{R(1,5,30,10,wh);R(3,7,26,6,'#8ac');R(2,14,3,2,mt);R(27,14,3,2,mt);R(4,2,2,4,mt);R(4,2,4,1,mt)},2,1);
mk('vaso','Vaso sanitário','Móveis',R=>{R(5,1,6,5,'#ddd');R(4,6,8,6,wh);R(5,12,6,3,'#ccc');R(6,7,4,3,'#9bd');R(5,1,6,1,mt)});
mk('tv_antiga','TV antiga','Móveis',R=>{R(5,0,1,3,mt);R(10,0,1,3,mt);R(2,3,12,10,'#444');R(3,4,8,8,'#7a8a88');R(12,5,1,2,'#c33');R(12,8,1,1,'#aaa');R(5,13,6,2,'#333')});
mk('piano','Piano','Móveis',R=>{R(1,2,30,13,'#1a1a1e');R(2,9,28,5,wh);for(let i=3;i<30;i+=2)R(i,9,1,5,'#999');for(let i=4;i<28;i+=4)R(i,9,1,3,bk);R(3,4,26,3,'#2a2a30')},2,1);
mk('relogio_pe','Relógio de pé','Móveis',R=>{R(5,0,6,15,wd4);R(6,1,4,4,wh);R(7,2,1,2,bk);R(8,3,1,1,bk);R(6,7,4,6,wd2);R(7,8,2,4,yl)});
mk('estante_larga','Estante larga','Móveis',R=>{R(1,1,30,14,wd4);[2,6,10].forEach(y=>{R(2,y,28,3,'#2a1a0a');for(let i=0;i<13;i++)R(3+i*2,y,1,3,['#a33','#38a','#3a3','#aa3','#a63'][i%5])})},2,1);
mk('vitrola','Vitrola','Móveis',R=>{R(3,7,10,7,wd1);R(4,8,8,3,bk);R(5,9,6,1,md);R(8,3,1,5,mt);R(8,3,5,1,mt);R(12,3,1,2,mt)});
mk('quadro','Quadro','Móveis',R=>{R(3,3,10,9,wd3);R(4,4,8,7,'#4a6a5a');R(6,6,3,3,'#caa');R(5,5,2,1,'#8ab')});
mk('quadro_sinistro','Retrato sinistro','Móveis',R=>{R(3,2,10,12,wd4);R(4,3,8,10,'#222');R(7,5,2,3,'#d9b08c');R(6,8,4,4,'#444');R(7,6,1,1,'#f22');R(8,6,1,1,'#f22')});
mk('janela','Janela','Móveis',R=>{R(3,2,10,12,wd2);R(4,3,8,10,bl2);R(7,3,2,10,wd2);R(4,7,8,1,wd2);R(5,4,2,2,'#cfe8f4')});
mk('saco','Saco','Móveis',R=>{R(4,6,8,8,'#b8a070');R(6,4,4,3,'#b8a070');R(6,6,4,1,'#8a7040');R(5,9,6,1,'#a89060')});
mk('fardo_feno','Fardo de feno','Móveis',R=>{R(2,6,12,8,'#d4b848');R(2,6,12,1,'#e8d068');R(2,9,12,1,'#a88a20');R(2,12,12,1,'#a88a20');R(4,6,1,8,'#8a6a20');R(11,6,1,8,'#8a6a20')});
mk('engradado','Engradado de garrafas','Móveis',R=>{R(3,8,10,6,wd1);R(3,8,10,1,wd3);[4,7,10].forEach(x=>{R(x,4,2,4,'#3a8a4a');R(x,3,2,1,'#2a6a3a')})});
mk('bancada_trabalho','Bancada de trabalho','Móveis',R=>{R(1,6,30,4,wd1);R(1,6,30,1,wd3);R(2,10,3,5,wd2);R(27,10,3,5,wd2);R(6,4,6,2,mt);R(8,3,2,1,mt);R(20,4,4,2,'#a33');R(22,2,1,2,wd2)},2,1);
mk('carrinho_mao','Carrinho de mão','Móveis',R=>{R(3,6,10,5,'#3a7a8a');R(2,5,12,1,'#2a5a6a');R(10,11,5,1,wd2);R(2,10,3,1,wd2);R(7,11,3,3,bk);R(8,12,1,1,mt)});
// Natureza
mk('arvore_morta','Árvore morta','Natureza',R=>{R(7,5,2,10,wd4);R(4,3,3,1,wd4);R(4,3,1,4,wd4);R(9,6,4,1,wd4);R(12,3,1,4,wd4);R(6,8,1,1,wd4);R(8,1,1,5,wd4);R(5,14,6,1,'#3a2a14')});
mk('pinheiro','Pinheiro','Natureza',R=>{R(7,12,2,3,wd2);R(7,1,2,2,'#1d4a2a');R(6,3,4,2,'#1d4a2a');R(5,5,6,2,'#256034');R(4,7,8,2,'#1d4a2a');R(3,9,10,3,'#256034')});
mk('carvalho','Carvalho','Natureza',R=>{R(14,20,4,11,wd4);R(12,29,8,2,'#3a2a14');R(6,3,20,6,gn2);R(3,7,26,10,gn);R(5,15,22,6,gn2);R(9,5,6,3,'#3f8a44');R(18,10,6,3,'#3f8a44');R(7,13,5,2,'#3f8a44')},2,2);
mk('salgueiro','Salgueiro','Natureza',R=>{R(14,16,4,15,wd4);R(5,2,22,7,'#3a6a3a');for(let i=0;i<10;i++)R(5+i*2+(i%2),8,1,10+(i*3%7),'#4a7a4a');R(8,4,6,2,'#4f8a4f')},2,2);
mk('palmeira','Palmeira','Natureza',R=>{R(7,6,2,9,'#8a6a3a');R(2,3,5,2,'#2e8a3a');R(9,3,5,2,'#2e8a3a');R(4,1,8,2,'#3a9a46');R(1,5,4,1,gn);R(11,5,4,1,gn);R(7,5,2,1,wd4)});
mk('arbusto','Arbusto','Natureza',R=>{R(3,7,10,7,gn2);R(4,5,8,3,gn);R(5,9,2,2,'#3f8a44');R(9,8,2,2,'#3f8a44')});
mk('arbusto_flores','Arbusto florido','Natureza',R=>{R(3,7,10,7,gn2);R(4,5,8,3,gn);R(5,6,1,1,'#f6a');R(9,7,1,1,'#fd4');R(7,10,1,1,'#f6a');R(4,10,1,1,'#fd4');R(11,10,1,1,'#f6a')});
mk('grama_alta','Mato alto','Natureza',R=>{for(let i=0;i<7;i++)R(2+i*2,8-(i%3)*2,1,7+(i%3)*2,i%2?'#3f7a3a':'#2e6a2e')});
mk('flores','Flores','Natureza',R=>{[[3,9,'#f6a'],[7,7,'#fd4'],[10,10,'#a8f'],[5,12,'#f66'],[12,7,'#fff']].forEach(f=>{R(f[0],f[1]+2,1,3,gn);R(f[0]-1,f[1],3,2,f[2])})});
mk('cogumelos','Cogumelos','Natureza',R=>{R(4,10,2,4,pp);R(2,8,6,3,'#c33');R(3,9,1,1,wh);R(6,9,1,1,wh);R(10,11,2,3,pp);R(8,9,6,3,rd);R(10,10,1,1,wh)});
mk('pedra','Pedra','Natureza',R=>{R(3,8,10,6,'#7a7a82');R(5,6,6,3,'#8a8a92');R(4,8,3,2,'#9a9aa2');R(3,13,10,1,'#55555c')});
mk('pedregulho','Pedregulho','Natureza',R=>{R(2,6,28,9,'#6a6a72');R(5,3,20,5,'#7a7a82');R(8,2,10,2,'#8a8a92');R(4,8,6,2,'#8a8a92');R(2,14,28,1,'#4a4a52');R(18,9,8,3,'#5a5a62')},2,1);
mk('tronco_caido','Tronco caído','Natureza',R=>{R(2,6,28,8,wd2);R(2,6,28,2,wd1);R(1,7,3,6,'#c8a070');R(2,8,1,3,wd2);R(12,5,3,1,gn2);R(20,13,6,1,'#3a2a14')},2,1);
mk('toco','Toco','Natureza',R=>{R(4,7,8,7,wd2);R(4,6,8,2,'#c8a070');R(6,7,4,1,wd1);R(3,13,10,1,'#3a2a14')});
mk('poco','Poço','Natureza',R=>{R(3,6,10,8,st1);R(4,7,8,4,'#0a1a2a');R(3,6,10,1,st3);R(3,2,1,5,wd2);R(12,2,1,5,wd2);R(3,2,10,1,wd2);R(7,3,1,3,'#a98')});
mk('fogueira','Fogueira','Natureza',R=>{R(3,12,10,2,wd2);R(2,13,12,1,'#3a2a14');R(6,6,4,7,og);R(7,4,2,5,yl);R(5,9,2,3,'#d62');R(9,9,2,3,'#d62');R(7,7,1,2,'#fff')});
mk('barraca','Barraca de camping','Natureza',R=>{R(15,0,2,5,wd2);for(let i=0;i<24;i++){const hw=Math.round(i*.6)+1;R(16-hw,4+i,2*hw,1,i%6<3?'#c8603a':'#b05030')}for(let i=8;i<24;i++){const hw=Math.round((i-8)*.25)+1;R(16-hw,4+i,2*hw,1,'#1a0e0a')}R(2,28,28,1,'#0005')},2,2);
mk('espantalho','Espantalho','Natureza',R=>{R(5,1,6,2,wd4);R(7,0,2,1,wd4);R(6,3,4,3,'#d4b060');R(6,4,1,1,bk);R(9,4,1,1,bk);R(7,6,2,8,wd2);R(2,7,12,1,wd2);R(6,7,4,5,'#a43');R(2,8,2,1,'#d4b848');R(12,8,2,1,'#d4b848')});
mk('cerca_madeira','Cerca de madeira','Natureza',R=>{R(1,6,14,2,wd1);R(1,10,14,2,wd1);R(2,4,2,11,wd3);R(7,4,2,11,wd3);R(12,4,2,11,wd3)});
mk('cerca_quebrada','Cerca quebrada','Natureza',R=>{R(1,6,6,2,wd1);R(9,10,6,2,wd1);R(2,4,2,11,wd3);R(12,6,2,9,wd3);R(7,9,2,6,wd3);R(6,5,5,1,wd1)});
mk('canteiro','Canteiro','Natureza',R=>{R(1,6,14,8,wd2);R(2,7,12,6,'#4a3018');for(let i=0;i<5;i++){R(3+i*2,5,1,4,gn);R(2+i*2,5,3,1,'#5a9a4a')}});
mk('abobora','Abóbora','Natureza',R=>{R(4,8,8,6,'#e87a20');R(3,9,10,4,'#e87a20');R(7,6,2,3,gn2);R(6,9,1,4,'#c85a10');R(9,9,1,4,'#c85a10')});
mk('lenha','Pilha de lenha','Natureza',R=>{R(2,8,12,6,wd2);[[3,9],[7,9],[11,9],[5,12],[9,12]].forEach(g=>{R(g[0]-1,g[1]-1,3,3,'#c8a070');R(g[0],g[1],1,1,wd1)})});
// Cemitério
mk('cruz','Cruz de pedra','Cemitério',R=>{R(7,2,2,12,st3);R(4,5,8,2,st3);R(5,13,6,2,'#4a5a3a');R(7,2,1,12,st1)});
mk('lapide_cruz','Lápide com cruz','Cemitério',R=>{R(4,5,8,9,st3);R(5,4,6,1,st3);R(7,6,2,5,st2);R(6,8,4,1,st2);R(3,13,10,2,'#4a5a3a')});
mk('lapide_antiga','Lápide antiga','Cemitério',R=>{R(4,6,8,8,'#7a7a80');R(5,4,6,3,'#7a7a80');R(6,3,4,1,'#7a7a80');R(5,8,6,1,'#4a4a52');R(5,10,4,1,'#4a4a52');R(3,13,10,2,'#3a4a2a');R(4,7,1,2,'#4a6a3a')});
mk('tumulo','Túmulo','Cemitério',R=>{R(2,5,28,10,st1);R(2,5,28,2,st3);R(4,8,24,5,st2);R(14,8,4,1,st3);R(15,7,2,5,st3)},2,1);
mk('estatua_anjo','Estátua de anjo','Cemitério',R=>{R(5,13,6,2,st2);R(6,6,4,7,st3);R(6,3,4,3,'#a0a0aa');R(2,4,4,6,st3);R(10,4,4,6,st3);R(3,3,2,2,st3);R(11,3,2,2,st3);R(7,4,1,1,st2)});
mk('gargula','Gárgula','Cemitério',R=>{R(4,12,8,3,st2);R(5,6,6,6,st2);R(5,4,6,3,'#5a5a66');R(4,2,1,3,st2);R(11,2,1,3,st2);R(2,7,3,4,st2);R(11,7,3,4,st2);R(6,5,1,1,'#f44');R(9,5,1,1,'#f44')});
mk('caixao','Caixão','Cemitério',R=>{R(6,1,4,2,wd4);R(5,3,6,2,wd4);R(4,5,8,8,wd4);R(5,13,6,2,wd4);R(6,3,4,10,wd2);R(7,5,2,6,'#caa');R(6,7,4,1,'#caa')});
mk('caixao_aberto','Caixão aberto','Cemitério',R=>{R(6,1,4,2,wd4);R(5,3,6,2,wd4);R(4,5,8,8,wd4);R(5,13,6,2,wd4);R(6,3,4,10,'#1a0a0a');R(11,2,4,10,wd2);R(7,6,2,2,'#d9b08c')});
mk('urna','Urna funerária','Cemitério',R=>{R(5,5,6,9,'#8a6a3a');R(4,4,8,2,'#a88a4a');R(6,2,4,3,'#a88a4a');R(6,8,4,3,'#d4b060');R(7,9,2,1,'#6a4a20')});
mk('cruz_madeira','Cruz de madeira','Cemitério',R=>{R(7,2,2,13,wd2);R(4,5,8,2,wd2);R(5,13,6,2,'#4a3a2a');R(6,4,4,1,'#c8a070')});
mk('grade_ferro','Grade de ferro','Cemitério',R=>{R(1,4,14,1,'#2a2a30');R(1,11,14,1,'#2a2a30');for(let i=0;i<5;i++){R(2+i*3,2,1,13,'#2a2a30');R(1+i*3,1,3,1,'#2a2a30')}});
// Ocultismo
mk('caldeirao','Caldeirão','Ocultismo',R=>{R(3,7,10,7,'#2a2a30');R(2,6,12,2,'#3a3a44');R(4,5,8,1,'#5ada5a');R(5,4,2,1,'#9aff9a');R(9,3,2,2,'#9aff9a');R(3,14,2,1,md);R(11,14,2,1,md);R(5,13,6,1,og)});
mk('vela','Vela','Ocultismo',R=>{R(7,8,2,6,'#eee8d0');R(7,7,2,1,'#c8c0a0');R(7,4,2,3,og);R(8,3,1,2,yl);R(5,14,6,1,md)});
mk('velas','Velas','Ocultismo',R=>{[[3,9,4],[7,6,7],[11,10,3]].forEach(g=>{R(g[0],g[1],2,g[2],'#eee8d0');R(g[0],g[1]-3,2,3,og);R(g[0],g[1]-4,1,1,yl)});R(2,14,12,1,'#5a1a1a')});
mk('candelabro','Candelabro','Ocultismo',R=>{R(7,6,2,8,'#c8a040');R(5,14,6,1,'#c8a040');R(2,6,12,1,'#c8a040');[2,7,12].forEach(x=>{R(x,3,2,3,'#eee8d0');R(x,1,2,2,og)})});
mk('altar_sacrificio','Altar de sacrifício','Ocultismo',R=>{R(2,6,28,9,st2);R(2,4,28,3,st1);R(4,3,24,1,st3);R(8,2,2,2,'#eee8d0');R(22,2,2,2,'#eee8d0');R(8,1,2,1,og);R(22,1,2,1,og);R(12,8,8,3,bd);R(14,7,4,1,bd)},2,1);
mk('totem','Totem','Ocultismo',R=>{R(5,1,6,14,wd2);R(6,2,4,3,'#a33');R(6,6,4,3,'#3a7a8a');R(6,10,4,3,'#d4b030');R(7,3,1,1,wh);R(8,3,1,1,wh);R(7,7,2,1,bk);R(7,11,2,1,bk)});
mk('idolo','Ídolo sombrio','Ocultismo',R=>{R(4,12,8,3,st2);R(5,4,6,8,'#3a3a44');R(4,2,8,3,'#4a4a54');R(5,1,1,2,'#4a4a54');R(10,1,1,2,'#4a4a54');R(6,3,1,1,'#f33');R(9,3,1,1,'#f33');R(6,7,4,1,'#222')});
mk('cristal','Cristal','Ocultismo',R=>{R(7,2,2,3,'#a8f0ff');R(6,5,4,6,'#6ad0f0');R(5,8,2,4,'#4ab0d8');R(9,7,3,5,'#8ae0ff');R(4,13,8,2,st2);R(7,5,1,4,'#fff')});
mk('espelho_negro','Espelho amaldiçoado','Ocultismo',R=>{R(4,1,8,14,'#4a3a1a');R(5,2,6,12,'#15101f');R(6,4,1,3,pu);R(9,8,1,3,pu);R(7,6,2,2,'#c070ff')});
mk('olho_parede','Olho na parede','Ocultismo',R=>{R(2,5,12,6,'#2a1020');R(3,4,10,8,wh);R(5,5,6,6,rd);R(7,6,2,4,bk);R(2,8,2,1,rd);R(12,8,2,1,rd)});
mk('livro_pedestal','Livro no pedestal','Ocultismo',R=>{R(6,8,4,6,st1);R(5,14,6,1,st2);R(3,5,10,4,'#4a2a2a');R(4,4,8,1,'#6a3a3a');R(7,5,2,3,'#d4b030');R(3,8,10,1,'#caa')});
mk('bola_cristal','Bola de cristal','Ocultismo',R=>{R(5,12,6,2,wd4);R(4,5,8,7,'#7a5ad0');R(5,4,6,1,'#7a5ad0');R(5,6,3,3,'#b8a0ff');R(6,7,1,1,'#fff')});
mk('cranio_vela','Crânio com vela','Ocultismo',R=>{R(5,8,6,5,pp);R(4,7,8,3,pp);R(5,9,2,2,bk);R(9,9,2,2,bk);R(7,11,2,1,bk);R(7,3,2,4,'#eee8d0');R(7,1,2,2,og)});
mk('boneca_pano','Boneca de pano','Ocultismo',R=>{R(6,4,4,4,'#e8d0b0');R(5,3,6,2,'#8a4a1a');R(5,8,6,5,'#6a4a7a');R(4,8,1,3,'#e8d0b0');R(11,8,1,3,'#e8d0b0');R(6,13,2,2,'#e8d0b0');R(8,13,2,2,'#e8d0b0');R(7,5,1,1,bk);R(9,5,1,1,bk);R(7,6,2,1,rd)});
mk('jaula','Jaula','Ocultismo',R=>{R(2,2,12,1,'#333');R(2,13,12,2,'#333');for(let i=0;i<5;i++)R(2+i*3,2,1,12,'#444');R(7,0,2,2,'#333');R(6,10,4,3,'#6a5a4a');R(7,11,1,1,wh)});
mk('correntes','Correntes','Ocultismo',R=>{[3,7,11].forEach((x,j)=>{for(let y=0;y<11;y+=2)R(x+(y%4?0:1),1+y+j,2,1,'#889');R(x-1,12+j,4,2,'#667')})});
mk('monolito','Monólito rúnico','Ocultismo',R=>{R(5,1,6,14,'#3a3a46');R(6,0,4,1,'#3a3a46');R(7,3,2,1,'#c070ff');R(6,5,1,3,'#c070ff');R(9,6,1,3,'#c070ff');R(7,10,2,1,'#c070ff');R(4,14,8,1,'#22222c')});
mk('obelisco','Obelisco','Ocultismo',R=>{R(4,13,8,2,st2);R(6,5,4,8,st3);R(7,2,2,3,st3);R(7,0,2,2,'#c8c8d4');R(8,3,1,9,st1)});
mk('tentaculos','Tentáculos','Ocultismo',R=>{const k='#3a5a2a';[[3,3],[7,1],[11,4]].forEach(g=>{R(g[0],g[1]+2,2,10,k);R(g[0]+1,g[1],2,3,'#4a6a3a');R(g[0],g[1]+6,1,1,'#c8d070')});R(2,13,12,2,'#2a3a1a')});
mk('casulo','Casulo','Ocultismo',R=>{R(5,2,6,12,'#d8d4c0');R(4,4,8,8,'#e8e4d0');R(6,1,4,1,'#bbb');R(6,6,1,5,'#b8b49a');R(9,5,1,6,'#b8b49a');R(7,13,2,2,'#a8a48a')});
// Cidade e veículos
mk('poste','Poste de luz','Cidade',R=>{R(7,3,2,11,'#3a3a44');R(5,2,6,2,'#3a3a44');R(5,4,6,1,'#ffe9a0');R(5,14,6,1,'#222')});
mk('semaforo','Semáforo','Cidade',R=>{R(7,7,2,8,'#333');R(6,1,4,7,bk);R(7,2,2,1,rd);R(7,4,2,1,'#aa2');R(7,6,2,1,'#2a2')});
mk('placa_pare','Placa de pare','Cidade',R=>{R(7,7,2,8,'#888');R(4,2,8,4,rd);R(5,1,6,6,rd);R(5,3,6,2,wh)});
mk('placa','Placa','Cidade',R=>{R(7,6,2,9,'#888');R(3,2,10,5,'#1e4a7a');R(4,3,8,3,'#3a7aaa');R(5,4,6,1,wh)});
mk('hidrante','Hidrante','Cidade',R=>{R(5,5,6,9,'#c22');R(4,7,8,2,'#a11');R(6,3,4,3,'#c22');R(3,8,1,2,'#a11');R(12,8,1,2,'#a11');R(4,13,8,2,'#833')});
mk('lixeira','Lixeira','Cidade',R=>{R(4,5,8,9,'#4a5a4a');R(3,4,10,2,'#5a6a5a');R(5,7,1,6,'#3a4a3a');R(8,7,1,6,'#3a4a3a');R(10,7,1,6,'#3a4a3a')});
mk('container','Container','Cidade',R=>{R(1,2,30,13,'#3a6a8a');for(let i=0;i<9;i++)R(3+i*3,3,1,11,'#2e5470');R(1,2,30,1,'#4a7a9a');R(1,14,30,1,'#1e3a50')},2,1);
mk('banco_praca','Banco de praça','Cidade',R=>{R(2,3,28,1,wd2);R(2,5,28,2,wd3);R(2,8,28,3,wd1);R(4,11,2,4,md);R(26,11,2,4,md)},2,1);
mk('cabine_tel','Cabine telefônica','Cidade',R=>{R(4,1,8,14,'#a22');R(5,3,6,9,'#9cc8d8');R(5,3,6,1,wh);R(4,1,8,2,'#d44');R(6,8,4,1,'#333')});
mk('correio','Caixa de correio','Cidade',R=>{R(4,4,8,10,'#2a5a9a');R(3,3,10,2,'#3a6aaa');R(5,7,6,1,bk);R(5,11,6,1,'#fd3');R(6,14,4,1,'#222')});
function car(id,n,col,o){o=o||{};mk(id,n,'Veículos',R=>{R(2,5,28,9,col);R(6,2,17,5,col);R(8,3,6,3,bl2);R(15,3,7,3,bl2);R(4,14,6,2,bk);R(21,14,6,2,bk);R(2,9,28,1,'#0003');R(1,8,2,3,'#fd8');R(29,8,2,3,'#d33');if(o.siren){R(11,1,3,1,'#33f');R(15,1,3,1,'#f33')}if(o.cross){R(12,8,4,1,'#f33');R(13,7,2,3,'#f33')}if(o.stripe)R(2,10,28,1,o.stripe)},2,1)}
car('carro_azul','Carro azul','#2a4a8a');car('carro_vermelho','Carro vermelho','#a22a2a');
car('carro_policia','Viatura','#e8e8f0',{siren:1,stripe:'#2a3f6a'});car('ambulancia','Ambulância','#f4f4f4',{siren:1,cross:1});
mk('van','Van','Veículos',R=>{R(1,3,30,11,'#b8b8a0');R(20,4,9,5,bl2);R(3,5,8,5,bl2);R(2,14,6,2,bk);R(22,14,6,2,bk);R(1,10,30,1,'#0003')},2,1);
mk('onibus','Ônibus','Veículos',R=>{R(1,2,46,13,'#d4a020');for(let i=0;i<8;i++)R(3+i*5,4,4,5,bl2);R(1,10,46,1,'#a47a10');R(6,14,6,2,bk);R(34,14,6,2,bk);R(42,4,4,10,'#2a2a30')},3,1);
mk('fonte_praca','Fonte de praça','Cidade',R=>{R(2,16,28,12,st1);R(4,18,24,8,'#3a7a9a');R(14,6,4,12,st3);R(10,4,12,3,st3);R(15,1,2,4,'#9ad0ea');R(6,20,6,1,'#6ab0cc');R(20,22,6,1,'#6ab0cc');R(2,27,28,2,st2)},2,2);
mk('estatua_praca','Estátua de praça','Cidade',R=>{R(4,12,8,3,st2);R(5,10,6,3,st1);R(6,2,4,8,'#8a6a3a');R(5,4,1,5,'#8a6a3a');R(10,4,1,5,'#8a6a3a');R(7,3,2,1,'#a88a4a')});
mk('barreira','Barreira','Cidade',R=>{R(1,5,14,3,'#e8e8e8');R(3,5,2,3,'#d33');R(7,5,2,3,'#d33');R(11,5,2,3,'#d33');R(3,8,2,7,'#888');R(11,8,2,7,'#888')});
mk('cone','Cone','Cidade',R=>{R(5,13,6,2,'#d62');R(6,9,4,4,'#e72');R(7,5,2,4,'#e72');R(6,10,4,1,wh)});
mk('fita_policia','Fita da polícia','Cidade',R=>{R(1,3,1,12,'#888');R(14,3,1,12,'#888');for(let i=0;i<7;i++){R(2+i*2,4,1,2,'#fd3');R(3+i*2,4,1,2,bk);R(2+i*2,8,1,2,'#fd3');R(3+i*2,8,1,2,bk)}});
mk('barraca_feira','Barraca de feira','Cidade',R=>{for(let i=0;i<10;i++)R(1+i*3,2,3,5,i%2?wh:'#c33');R(2,7,2,8,wd2);R(28,7,2,8,wd2);R(2,10,28,3,wd1);R(6,8,3,2,'#e33');R(14,8,3,2,'#ec3');R(22,8,3,2,'#6c3')},2,1);
mk('outdoor','Outdoor','Cidade',R=>{R(7,20,3,11,md);R(22,20,3,11,md);R(2,2,28,18,'#2a2a30');R(3,3,26,16,'#c84a3a');R(5,6,12,3,'#f4e4a0');R(5,11,18,2,'#f4e4a0');R(5,14,10,2,'#f4e4a0')},2,2);
mk('carrinho_compras','Carrinho de compras','Cidade',R=>{R(3,5,10,6,mt);R(3,5,10,1,'#889');R(5,6,1,5,'#889');R(8,6,1,5,'#889');R(11,3,3,3,'#889');R(4,12,2,2,bk);R(10,12,2,2,bk)});
mk('ponto_onibus','Ponto de ônibus','Cidade',R=>{R(1,2,30,2,md);R(2,2,2,13,md);R(28,2,2,13,md);R(4,4,24,7,'#9cc8d8');R(6,12,20,2,wd1);R(8,6,6,2,'#2a5a8a')},2,1);
mk('muro_baixo','Muro baixo','Cidade',R=>{R(1,6,14,9,'#8a7a6a');R(1,6,14,2,'#a89a8a');R(1,10,14,1,'#6a5a4a');R(5,6,1,4,'#6a5a4a');R(10,10,1,5,'#6a5a4a')});
mk('cerca_arame','Cerca de arame','Cidade',R=>{for(let i=0;i<7;i++)R(1+i*2,4,1,8,'#99a');R(1,2,1,13,'#556');R(14,2,1,13,'#556');R(1,2,14,1,'#778')});
mk('caixa_luz','Caixa de luz','Cidade',R=>{R(4,4,8,10,'#778');R(5,5,6,4,'#99a');R(7,10,2,1,'#fd3');R(6,14,4,1,'#445')});
// Hospital e laboratório
mk('cama_hospital','Cama de hospital','Hospital e lab',R=>{R(2,3,12,12,'#bbb');R(3,4,10,10,'#dde');R(3,4,10,3,wh);R(3,9,10,5,'#8ac');R(2,14,2,2,md);R(12,14,2,2,md)});
mk('maca','Maca','Hospital e lab',R=>{R(2,4,12,9,'#bbb');R(3,5,10,7,wh);R(5,5,6,3,'#fff');R(3,12,2,3,md);R(11,12,2,3,md)});
mk('armario_med','Armário médico','Hospital e lab',R=>{R(3,1,10,14,'#cfd8dc');R(4,2,8,5,'#9cc8d8');R(4,9,8,5,'#9cc8d8');R(7,3,2,3,'#c22');R(6,4,4,1,'#c22')});
mk('cadeira_rodas','Cadeira de rodas','Hospital e lab',R=>{R(4,2,2,7,md);R(4,7,8,2,'#2a4a7a');R(10,8,2,4,'#2a4a7a');R(2,9,6,6,bk);R(3,10,4,4,'#555');R(9,13,4,3,bk)});
mk('monitor_med','Monitor cardíaco','Hospital e lab',R=>{R(3,4,10,7,'#223');R(4,5,8,5,'#142');R(4,7,2,1,'#3f3');R(6,6,1,3,'#3f3');R(7,5,2,2,'#3f3');R(9,8,1,2,'#3f3');R(7,11,2,3,md);R(5,14,6,1,md)});
mk('bancada_lab','Bancada de laboratório','Hospital e lab',R=>{R(1,6,30,3,'#8a9aa0');R(1,9,30,6,'#cfd8dc');R(2,10,8,4,mt);R(5,2,3,4,'#6ad08a');R(5,1,3,1,'#aaa');R(14,3,2,3,'#d06a6a');R(14,2,2,1,'#aaa');R(22,2,3,4,'#6aa0d0');R(26,3,3,3,md)},2,1);
mk('tanque','Tanque de espécime','Hospital e lab',R=>{R(3,4,10,24,'#5aa88a');R(4,5,8,22,'#3a8a6a');R(2,2,12,3,md);R(2,28,12,3,md);R(6,10,4,10,'#1a3a2a');R(6,8,4,3,'#1a3a2a');R(5,22,1,1,'#bfe');R(10,16,1,1,'#bfe')},1,2);
mk('computador','Computador','Hospital e lab',R=>{R(3,2,10,8,'#bbb');R(4,3,8,6,'#134');R(5,4,6,1,'#4f4');R(5,6,4,1,'#4f4');R(6,10,4,2,'#999');R(3,12,10,2,'#aaa')});
mk('servidor','Servidor','Hospital e lab',R=>{R(3,1,10,14,'#2a2a34');for(let i=0;i<4;i++){R(4,2+i*3,8,2,'#3a3a46');R(10,2+i*3,1,1,'#3f3');R(8,2+i*3,1,1,'#f93')}});
mk('cofre_forte','Cofre','Hospital e lab',R=>{R(2,3,12,12,'#556');R(3,4,10,10,'#667');R(8,6,4,6,'#556');R(9,8,2,2,yl);R(4,6,3,6,'#445');R(3,14,2,1,bk)});
mk('gerador','Gerador','Hospital e lab',R=>{R(2,4,12,10,'#a8741c');R(3,5,10,4,'#c8941c');R(3,10,10,3,'#555');R(5,2,2,3,'#555');R(10,6,2,2,rd)});
mk('mesa_cirurgia','Mesa de cirurgia','Hospital e lab',R=>{R(1,6,30,4,'#cfd8dc');R(1,6,30,1,'#eef');R(5,10,2,5,md);R(25,10,2,5,md);R(14,10,4,3,md);R(5,2,2,4,mt);R(5,2,8,1,mt);R(9,2,1,3,wh)},2,1);
// Iluminação
mk('tocha_parede','Tocha de parede','Iluminação',R=>{R(6,7,4,6,wd4);R(5,3,6,5,og);R(6,2,4,3,yl);R(7,1,2,2,'#ff9');R(4,12,8,2,md)});
mk('lampiao','Lampião','Iluminação',R=>{R(7,0,2,2,md);R(5,2,6,1,md);R(5,3,6,8,'#ffe9a0');R(6,5,4,4,'#fff6c0');R(5,11,6,1,md)});
mk('lampada_pend','Lâmpada pendente','Iluminação',R=>{R(8,0,1,5,bk);R(6,5,5,2,'#444');R(5,7,6,4,'#ffe9a0');R(6,8,4,2,wh)});
mk('braseiro','Braseiro','Iluminação',R=>{R(3,8,10,6,'#3a3a44');R(2,7,12,2,md);R(4,5,8,3,og);R(5,3,6,3,yl);R(6,2,2,2,'#ff9');R(4,14,2,1,md);R(10,14,2,1,md)});
mk('abajur','Abajur','Iluminação',R=>{R(7,8,2,5,wd2);R(6,13,4,2,wd2);R(4,3,8,5,'#f0d890');R(5,4,6,3,'#ffe9a8')});
// Chão (decalques)
mk('sangue_poca','Poça de sangue','Chão',R=>{R.o(8,8,6,4,bd);R.o(6,9,3,2,'#9a1420');R.o(11,7,2,1.5,'#9a1420')});
mk('sangue_respingo','Respingos de sangue','Chão',R=>{[[3,4,2],[8,2,1],[11,6,2],[6,9,3],[12,11,1],[2,12,2],[9,13,1]].forEach(g=>R(g[0],g[1],g[2],g[2],bd))});
mk('pegadas_sangue','Pegadas de sangue','Chão',R=>{R(3,10,2,3,bd);R(3,14,2,1,bd);R(8,6,2,3,bd);R(8,10,2,1,bd);R(12,2,2,3,bd);R(12,6,2,1,bd)});
mk('rastro_sangue','Rastro de sangue','Chão',R=>{for(let i=0;i<8;i++)R(2+i*3,6+Math.round(Math.sin(i)*2),4,3,bd);R(26,9,4,4,bd)},2,1);
mk('giz_corpo','Contorno de giz','Chão',R=>{R.r(8,3,2,2,.5,wh);R(4,5,8,1,wh);R(4,5,1,5,wh);R(11,5,1,5,wh);R(6,10,1,5,wh);R(9,10,1,5,wh);R(6,14,4,1,wh);R(2,5,2,1,wh);R(12,5,2,1,wh)});
mk('circulo_ritual','Círculo ritual','Chão',R=>{R.r(16,16,13,13,1,'#8a1a22');R.r(16,16,10,10,.5,'#8a1a22');for(let a=0;a<8;a++)R(16+Math.round(Math.cos(a*Math.PI/4)*11.5)-1,16+Math.round(Math.sin(a*Math.PI/4)*11.5)-1,2,2,'#c03040')},2,2);
mk('pentagrama','Pentagrama','Chão',R=>{const P=[0,1,2,3,4].map(k=>{const a=(-90+k*72)*Math.PI/180;return[16+Math.cos(a)*11,16+Math.sin(a)*11]});[0,2,4,1,3,0].forEach((k,i,A)=>{if(i)R.l(P[A[i-1]][0],P[A[i-1]][1],P[k][0],P[k][1],.7,'#b02030')});R.r(16,16,13,13,.8,'#b02030')},2,2);
mk('runas_chao','Runas brilhantes','Chão',R=>{[[3,3],[10,4],[5,10],[11,11]].forEach(g=>{R(g[0],g[1],1,4,'#9a7aff');R(g[0],g[1]+1,3,1,'#9a7aff');R(g[0]+2,g[1]+2,1,2,'#9a7aff')})});
mk('rachadura','Rachadura','Chão',R=>{R.l(2,3,6,7,.4,'#1a1a1e');R.l(6,7,5,11,.4,'#1a1a1e');R.l(5,11,9,14,.4,'#1a1a1e');R.l(6,7,11,8,.4,'#1a1a1e')});
mk('poca_agua','Poça de água','Chão',R=>{R.o(8,9,6,3,'#2a5a7a');R.o(7,8,3,1.2,'#5a9aba')});
mk('lixo','Lixo','Chão',R=>{[[3,4,3,2,'#8a8a70'],[8,8,4,3,'#6a7a5a'],[4,11,3,2,'#aaa'],[11,3,2,3,'#a86'],[10,12,3,2,'#789']].forEach(g=>R(g[0],g[1],g[2],g[3],g[4]))});
mk('folhas_soltas','Folhas soltas','Chão',R=>{[[3,3,'#b0661c'],[9,2,'#8a3a14'],[6,7,'#caa040'],[12,6,'#b0661c'],[3,11,'#8a3a14'],[10,12,'#caa040'],[7,14,'#b0661c']].forEach(g=>R(g[0],g[1],2,1,g[2]))});
mk('ossos','Ossos','Chão',R=>{R(3,4,6,1,pp);R(2,3,2,2,pp);R(8,3,2,2,pp);R(4,12,6,1,pp);R(3,11,2,2,pp);R(9,11,2,2,pp);R(10,6,4,3,pp);R(11,7,1,1,bk);R(13,7,1,1,bk)});
mk('teia_canto','Teia de aranha','Chão',R=>{R.l(0,0,14,0,.3,'#ddd');R.l(0,0,0,14,.3,'#ddd');R.l(0,0,10,10,.3,'#ddd');R.l(5,0,0,5,.3,'#ddd');R.l(9,0,0,9,.3,'#ddd');R.l(13,0,0,13,.3,'#ddd')});
mk('cinzas','Cinzas','Chão',R=>{R.o(8,8,6,4,'#3a3a3e');R.o(8,8,4,2.5,'#2a2a2e');R(5,6,1,1,'#555');R(11,9,1,1,'#555')});
mk('vidro_quebrado','Vidro quebrado','Chão',R=>{[[3,3,2,1],[4,4,1,2],[9,7,3,1],[10,8,1,2],[6,11,2,1],[12,12,2,1]].forEach(g=>R(g[0],g[1],g[2],g[3],'#bfe8f4'))});
mk('mancha_oleo','Mancha de óleo','Chão',R=>{R.o(8,8,6,5,'#16161c');R.o(7,7,3,2,'#2a2a44')});
mk('escombros','Escombros','Chão',R=>{R(2,8,5,4,'#6a6a72');R(8,6,5,5,'#5a5a62');R(5,3,3,3,'#7a7a82');R(10,11,4,3,'#8a7a6a');R(3,12,3,2,'#4a4a52')});
mk('faixa_pedestre','Faixa de pedestres','Chão',R=>{for(let i=0;i<4;i++)R(1,1+i*4,14,2,wh)});
mk('pegadas_lama','Pegadas de lama','Chão',R=>{R(3,10,2,3,'#3a2a14');R(8,6,2,3,'#3a2a14');R(12,2,2,3,'#3a2a14');R(7,12,2,3,'#3a2a14')});
mk('marca_queimada','Marca de queimado','Chão',R=>{R.o(8,8,6,6,'#1a1410');R.o(8,8,4,4,'#0e0a08')});
mk('gosma_chao','Gosma','Chão',R=>{R.o(8,9,6,4,'#4aaa4a');R.o(6,8,2,1.5,'#7ada7a');R.o(11,10,2,1,'#7ada7a')});
mk('tapete_vermelho','Tapete vermelho','Chão',R=>{R(1,2,30,12,'#8a2030');R(3,4,26,8,'#a83040');R(5,6,22,4,'#8a2030');R(1,2,30,1,'#c8a040');R(1,13,30,1,'#c8a040')},2,1);
mk('tapete_azul','Tapete azul','Chão',R=>{R(1,2,30,12,'#2a3a6a');R(3,4,26,8,'#3a4a8a');R(5,6,22,4,'#2a3a6a');R(1,2,30,1,'#c8c8d0');R(1,13,30,1,'#c8c8d0')},2,1);
mk('tapete_redondo','Tapete redondo','Chão',R=>{R.o(16,16,14,14,'#5a2a6a');R.o(16,16,11,11,'#7a3a8a');R.o(16,16,7,7,'#5a2a6a');R.o(16,16,3,3,'#c8a040')},2,2);
mk('tapete_persa','Tapete persa','Chão',R=>{R(2,2,28,28,'#7a2a2a');R(4,4,24,24,'#c8a040');R(5,5,22,22,'#8a3030');R.o(16,16,9,9,'#2a3a6a');R.o(16,16,5,5,'#c8a040')},2,2);
mk('cova_aberta','Cova aberta','Chão',R=>{R(3,3,10,11,'#4a3018');R(4,4,8,9,'#0a0604');R(2,2,12,2,'#5a3a20');R(4,13,8,1,'#3a2410');R(12,10,3,4,'#5a3a20')});
mk('bueiro','Bueiro','Chão',R=>{R.o(8,8,6,6,'#2a2a30');R.o(8,8,5,5,'#444');for(let i=0;i<5;i++)R(4,5+i*2,8,1,'#222')});
mk('fenda','Fenda sobrenatural','Chão',R=>{[['#0a0412',1],['#c070ff',.3]].forEach(c=>{R.l(8,0,6,5,c[1],c[0]);R.l(6,5,10,9,c[1],c[0]);R.l(10,9,7,16,c[1],c[0])})});
// Pistas
mk('foto','Fotografia','Pistas',R=>{R(3,4,10,8,wh);R(4,5,8,6,'#7a8a9a');R(6,7,2,2,'#d9b08c');R(5,9,6,2,'#445');R(3,12,10,1,'#ccc')});
mk('fita_cassete','Fita cassete','Pistas',R=>{R(2,5,12,8,'#222');R(3,6,10,3,'#ddd');R(5,7,2,2,'#222');R(9,7,2,2,'#222');R(4,10,8,2,md)});
mk('mapa','Mapa','Pistas',R=>{R(2,3,12,10,'#d8c890');R(3,4,10,8,'#e8d8a0');R(4,6,3,1,rd);R(6,6,1,4,rd);R(9,5,4,1,'#654');R(8,9,5,1,'#654');R(11,8,2,2,rd)});
mk('livro_antigo','Livro antigo','Pistas',R=>{R(3,3,10,11,'#5a3a1a');R(4,3,1,11,'#3a2210');R(6,5,6,1,'#c8a040');R(6,8,5,1,'#c8a040');R(5,13,8,1,'#d8c8a0')});
mk('grimorio','Grimório','Pistas',R=>{R(3,3,10,11,'#2a1a3a');R(4,3,1,11,'#1a0e28');R(7,6,4,4,'#9a4ad0');R(8,7,2,2,'#e0b0ff');R(6,12,6,1,'#7a5a9a')});
mk('carta','Carta','Pistas',R=>{R(2,5,12,8,'#e8e0c0');R(2,5,12,1,'#bbb');R(2,5,6,3,'#d0c8a8');R(7,8,2,2,rd)});
mk('amuleto','Amuleto','Pistas',R=>{R(7,1,2,4,'#c8a040');R(5,5,6,7,'#c8a040');R(6,6,4,5,'#6a2a7a');R(7,8,2,1,'#f5f')});
mk('faca_ritual','Faca ritual','Pistas',R=>{R(7,2,2,8,'#cfd4dc');R(7,2,1,8,wh);R(5,10,6,1,'#c8a040');R(7,11,2,3,wd2);R(7,5,2,1,bd)});
mk('cranio','Crânio','Pistas',R=>{R(4,4,8,7,pp);R(5,3,6,1,pp);R(5,6,2,2,bk);R(9,6,2,2,bk);R(7,8,2,1,bk);R(5,11,6,2,pp);R(6,11,1,2,bk);R(9,11,1,2,bk)});
mk('celular','Celular','Pistas',R=>{R(5,2,6,12,'#223');R(6,3,4,8,'#4a7a9a');R(7,5,2,1,wh);R(7,12,2,1,'#556');R(6,4,3,1,wh)});
mk('gravador','Gravador','Pistas',R=>{R(3,5,10,8,md);R(4,6,4,3,'#222');R(5,7,2,1,'#999');R(9,6,3,2,'#3a3a3a');R(9,10,2,2,rd);R(4,11,4,1,'#888')});
mk('pergaminho','Pergaminho','Pistas',R=>{R(3,3,10,10,'#d8c890');R(2,3,1,10,'#b8a870');R(13,3,1,10,'#b8a870');R(5,5,6,1,'#654');R(5,7,6,1,'#654');R(5,9,4,1,'#654')});
mk('frasco','Frasco','Pistas',R=>{R(6,3,4,2,mt);R(5,5,6,1,'#cde');R(4,6,8,8,'#bfe8f0');R(5,9,6,5,'#6ad08a');R(6,10,1,2,'#cfffdc')});
mk('relogio_bolso','Relógio de bolso','Pistas',R=>{R(7,1,2,2,'#c8a040');R(4,3,8,10,'#c8a040');R(5,4,6,8,wh);R(8,5,1,3,bk);R(8,7,3,1,bk);R(4,3,8,1,'#e8c060')});
// Portas e entradas
mk('porta_dupla','Porta dupla','Portas',R=>{R(2,1,12,14,wd2);R(3,2,5,12,wd1);R(8,2,5,12,wd1);R(7,7,1,2,yl);R(8,7,1,2,yl);R(2,1,12,1,wd4)});
mk('porta_ferro','Porta de ferro','Portas',R=>{R(4,1,8,14,'#445');R(5,2,6,12,'#667');R(5,5,6,1,'#334');R(5,9,6,1,'#334');R(9,7,1,2,'#c8a040');R(6,3,1,1,'#99a');R(9,3,1,1,'#99a')});
mk('alcapao','Alçapão','Portas',R=>{R(2,3,12,10,wd2);R(3,4,10,8,wd1);R(7,5,2,2,'#c8a040');R(3,8,10,1,wd2);R(2,3,12,1,wd4)});
mk('portao_ferro','Portão de ferro','Portas',R=>{R(1,1,30,1,'#2a2a30');R(1,6,30,1,'#2a2a30');R(1,11,30,1,'#2a2a30');for(let i=0;i<10;i++){R(2+i*3,0,1,15,'#3a3a44');R(1+i*3,0,3,1,'#3a3a44')}R(14,7,4,4,st1)},2,1);
mk('caverna','Entrada de caverna','Portas',R=>{R(2,6,28,25,'#4a4a52');R(5,3,22,10,'#5a5a62');R(8,1,16,5,'#6a6a72');R(8,12,16,19,'#050408');R(10,10,12,4,'#050408');R(6,28,20,3,'#3a3a42')},2,2);
mk('elevador','Elevador','Portas',R=>{R(2,1,12,14,'#778');R(3,2,5,12,'#99a');R(8,2,5,12,'#99a');R(7,2,2,12,'#556');R(6,0,4,1,'#fd3')});
mk('passagem','Passagem escura','Portas',R=>{R(3,2,10,13,'#4a4a52');R(4,3,8,12,'#050408');R(3,2,10,1,'#6a6a72');R(5,5,1,1,'#222')});
// Eventos
mk('armadilha','Armadilha','Eventos',R=>{R(2,10,12,3,md);for(let i=0;i<5;i++){R(3+i*2,5,1,6,'#bcc');R(3+i*2,4,1,1,wh)}});
mk('gaveta','Gaveta','Eventos',R=>{R(2,5,12,9,wd1);R(2,5,12,1,wd3);R(3,7,10,3,wd2);R(3,11,10,2,wd2);R(7,8,2,1,yl);R(7,12,2,1,yl)});
mk('cena','Cena com diálogo','Eventos',R=>{R(2,2,12,8,'#f4f0e0');R(4,10,3,3,'#f4f0e0');R(5,5,1,1,bk);R(7,5,1,1,bk);R(9,5,1,1,bk)});
mk('sussurro','Sussurros','Eventos',R=>{R(2,6,2,4,'#9a7aff');R(5,4,2,8,'#9a7aff');R(8,2,2,12,'#7a5ad0');R(11,4,2,8,'#9a7aff');R(14,6,1,4,'#9a7aff')});
mk('cura','Cura','Eventos',R=>{R(6,2,4,12,'#3ac060');R(2,6,12,4,'#3ac060');R(7,3,2,10,'#8affa0');R(3,7,10,2,'#8affa0')});
// Construções (gerador de prédios: parede, telhado, janelas, porta e enfeites)
function bld(id,n,tw,th,o){mk(id,n,'Construções',R=>{
 const W=tw*16,H=th*16,rh=o.rh||Math.max(6,Math.round(H*.36)),fl=o.fl||1,cx=W>>1,wl=o.wall,tr=o.trim||'#d8d0c0';
 R(1,rh,W-2,H-rh-1,wl);R(1,H-4,W-2,3,'#0002');
 for(let i=0;i<rh;i++){const ins=Math.round((rh-1-i)*(W/2-3)/Math.max(1,rh-1));R(ins,i,W-2*ins,1,i%4===3?(o.roof2||o.roof):o.roof)}
 R(0,rh-1,W,2,'#0006');
 if(o.chim){const x=Math.round(W*.68);R(x,Math.max(0,rh-10),4,9,'#5a3a30');R(x-1,Math.max(0,rh-11),6,2,'#3a2018')}
 if(o.tower)[0,W-9].forEach(x=>{R(x,rh-4,9,H-rh+3,o.wall2||wl);R(x,rh-4,9,1,'#0004');for(let i=0;i<7;i++)R(x+4-i,rh-12+i,2+2*i,1,o.roof);R(x+3,rh+1,3,5,o.win||bl2);R(x+3,rh+10,3,5,o.win||bl2)});
 if(o.cross){R(cx,0,1,5,yl);R(cx-1,1,3,1,yl);for(let i=0;i<7;i++)R(cx-i-1,5+i,2*i+2,1,o.roof);R(cx-5,12,10,rh-10,wl);R(cx-5,12,10,1,'#0004');R(cx-2,15,4,7,'#16161e')}
 const fh2=Math.floor((H-rh-8)/fl);
 for(let f=0;f<fl;f++){const y=rh+3+f*fh2,m=o.nw==null?2:o.nw;for(let j=0;j<m;j++){const x=Math.round((j+1)*W/(m+1))-2;if(f===fl-1&&Math.abs(x+2-cx)<7)continue;
  R(x-1,y-1,6,6,tr);R(x,y,4,4,o.win||bl2);R(x+2,y,1,4,tr);R(x,y+2,4,1,tr);if(o.boards){R(x-1,y,6,1,wd1);R(x-1,y+3,6,1,wd1)}}}
 if(o.gate){R(cx-8,H-16,16,15,o.door);R(cx-7,H-15,14,13,o.door2||o.door);for(let i=0;i<14;i++){R(cx-7+i,H-15+i,1,1,'#0004');R(cx+6-i,H-15+i,1,1,'#0004')}R(cx-8,H-16,16,1,'#0006')}
 else{R(cx-3,H-11,6,10,o.door||wd2);R(cx-2,H-10,4,9,'#0002');R(cx+1,H-6,1,2,yl);R(cx-4,H-2,8,1,'#0005')}
 if(o.awn)for(let x=3;x<W-3;x+=3)R(x,H-17,3,4,((x-3)/3|0)%2?o.awn[1]:o.awn[0]);
 if(o.neon)R(cx-8,rh+2,16,3,o.neon);
 if(o.redx){R(cx-6,rh+1,13,11,'#fff');R(cx-1,rh+2,3,9,'#c22');R(cx-4,rh+5,9,3,'#c22')}
 if(o.sym){R(cx-1,rh+2,2,7,yl);R(cx-3,rh+4,6,2,yl)}
 if(o.ruin){R(cx+2,0,W-cx-4,rh-5,'clear');R(cx+6,rh-5,7,4,'clear');R(4,rh+6,9,9,'#120c0a')}
 R(0,H-1,W,1,'#0005')},tw,th)}
bld('casa_pequena','Casa pequena',4,3,{wall:'#d8c8a0',roof:'#8a2a2a',roof2:'#7a2020',nw:2,chim:1});
bld('casa_grande','Casa grande',5,4,{wall:'#a8b8c8',roof:'#4a4a5a',roof2:'#3a3a4a',fl:2,nw:3,chim:1,rh:22});
bld('casebre','Casebre de madeira',3,3,{wall:wd1,roof:wd4,roof2:'#4a2e14',trim:wd3,nw:1,chim:1});
bld('mansao','Mansão',7,5,{wall:'#4a4a5a',wall2:'#3a3a48',roof:'#22222e',roof2:'#1a1a24',trim:'#2a2a36',win:yl,fl:2,nw:4,tower:1,rh:30,door:'#2a1a1a'});
bld('igreja','Igreja',5,5,{wall:'#c8c0b0',roof:'#555566',roof2:'#444455',trim:'#a09888',win:'#b080e0',nw:2,cross:1,rh:34,door:wd4});
bld('capela','Capela',3,3,{wall:'#c8c0b0',roof:'#555566',trim:'#a09888',win:'#b080e0',nw:1,sym:1,door:wd4});
bld('delegacia','Delegacia',5,3,{wall:'#4a5a7a',roof:'#2a3a5a',trim:'#c8d0e0',nw:3,neon:'#4a7ae8',rh:9});
bld('hospital','Hospital',6,4,{wall:'#e8e8ee',roof:'#9aa4b0',trim:'#aab',fl:2,nw:4,redx:1,rh:12});
bld('loja','Loja',4,3,{wall:'#c8a878',roof:'#6a4a3a',trim:'#fff',win:'#cfe8f4',nw:2,awn:['#c33','#eee'],rh:10});
bld('bar','Bar',4,3,{wall:'#3a2a24',roof:'#2a1a16',trim:wd3,win:'#e8a040',nw:2,neon:'#f44',rh:10,door:'#1a0e0a'});
bld('celeiro','Celeiro',5,4,{wall:'#9a2a2a',roof:'#5a1a1a',roof2:'#4a1414',trim:'#eee',gate:1,door:'#7a1e1e',nw:0,rh:24});
bld('galpao','Galpão',5,3,{wall:'#8a9098',roof:'#5a6068',trim:'#aab',gate:1,door:'#6a7078',nw:3,rh:10});
bld('casa_abandonada','Casa abandonada',4,3,{wall:'#6a6258',roof:'#3a342e',trim:'#4a443a',win:'#14100e',boards:1,nw:2});
bld('ruina','Casa em ruínas',4,3,{wall:'#7a7268',roof:'#4a443c',trim:'#5a544a',win:'#14100e',nw:2,ruin:1});
mk('mausoleu','Mausoléu','Construções',R=>{for(let i=0;i<10;i++){const hw=2+i*2;R(24-hw,i,2*hw,1,st3)}R(2,10,44,3,st1);R(2,13,44,31,st2);for(let i=0;i<4;i++)R(5+i*10,13,4,31,st3);R(20,22,8,22,bk);R(22,28,4,1,'#c070ff');R(0,44,48,4,st1);R(22,5,4,3,st2)},3,3);
mk('farol','Farol','Construções',R=>{R(9,10,14,2,md);R(10,12,12,10,'#ffe9a0');R(15,12,2,10,md);for(let i=0;i<6;i++)R(10+i,4+i,12-2*i,1,rd);for(let y=22;y<76;y++){const hw=5+Math.round((y-22)*3/54);R(16-hw,y,2*hw,1,Math.floor((y-22)/9)%2?'#c33':'#eee')}R(9,22,14,2,md);R(14,66,4,10,wd2)},2,5);
mk('moinho','Moinho','Construções',R=>{for(let y=24;y<78;y++){const hw=11+Math.round((y-24)*4/54);R(24-hw,y,2*hw,1,'#d8c8a0')}for(let i=0;i<14;i++){const hw=1+i;R(24-hw,10+i,2*hw,1,'#8a2a2a')}R(22,22,4,4,wd4);[[4,4],[44,4],[4,44],[44,44]].forEach(g=>{R.l(24,24,g[0],g[1],1.6,wd3)});R(21,64,6,14,wd2);R(22,40,4,5,bl2)},3,5);
// Brilho de fontes de luz (cor RGB; efeito aditivo desenhado pelo jogo)
const GL={tocha:'255,150,50',tocha_parede:'255,150,50',lampiao:'255,225,140',lampada_pend:'255,225,140',braseiro:'255,130,40',fogueira:'255,140,40',vela:'255,200,100',velas:'255,200,100',candelabro:'255,190,90',abajur:'255,220,140',poste:'255,235,170',lareira:'255,130,40',fogao:'255,130,40',cristal:'120,220,255',bola_cristal:'160,130,255',runas_chao:'150,110,255',fenda:'190,100,255',pentagrama:'200,40,60',circulo_ritual:'200,40,60',farol:'255,240,170',portal:'190,100,255',tv_antiga:'120,160,160',monitor_med:'80,255,120',tanque:'80,220,150',computador:'80,160,255',cranio_vela:'255,200,100',espelho_negro:'170,90,230',amuleto:'200,100,255',grimorio:'170,90,230',altar:'255,200,100',altar_sacrificio:'255,160,80'};
Object.keys(GL).forEach(k=>{if(SPR[k])SPR[k].gl=GL[k]});
const CATS={};Object.keys(SPR).forEach(k=>(CATS[SPR[k].cat]=CATS[SPR[k].cat]||[]).push(k));
const SOPT=Object.keys(CATS).map(c=>'<optgroup label="'+c+'">'+CATS[c].map(k=>'<option value="'+k+'">'+SPR[k].n+'</option>').join('')+'</optgroup>').join('');
const selOpt=(h,v)=>h.replace('value="'+v+'"','value="'+v+'" selected');
const OPT=(l,v)=>l.map(x=>'<option value="'+esc(x[0])+'"'+(String(x[0])===String(v)?' selected':'')+'>'+esc(x[1])+'</option>').join('');
const PS=['investigador','ocultista','soldado','medica','policial','detetive','jornalista','cientista'];
// ---------- terrenos ----------
const TL=[['Grama','#2f4a2c'],['Madeira','#7a5a3a'],['Parede','#3a3640'],['Água','#1d3b5c'],['Ritual','#4a1218'],['Concreto','#57575f'],['Terra','#6a4a2c'],['Abismo','#050408'],
 ['Areia','#c9b27a'],['Neve','#dfe6ee'],['Calçada','#6b6b70'],['Asfalto','#2c2c32'],['Rua com faixa','#2c2c32'],['Piso xadrez','#d8d4c8'],['Tapete vermelho','#7a1a26'],['Lama','#3a3020'],
 ['Lava','#c8400a'],['Tijolos','#8a4a3a'],['Mato alto','#2a5028'],['Folhas secas','#6a4a24'],['Cascalho','#7c7870'],['Gelo','#a8d4e8'],['Madeira manchada','#7a5a3a'],['Carpete','#4a4a5a'],
 ['Azulejo','#cfd8dc'],['Laje escura','#2a2a34'],['Parede de madeira','#5a3a22'],['Água rasa','#3a7a9a'],['Ponte','#8a6a3a'],['Campo arado','#5a3a20'],['Parede de pedra','#5a5a66'],['Parede clara','#b8a888']];
const TC=TL.map(t=>t[1]),TN=TL.map(t=>t[0]);
const TI=TC.map((col,t)=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');x.fillStyle=col;x.fillRect(0,0,32,32);let s=t*97+1;const rn=()=>(s=s*16807%2147483647)/2147483647;
 const dots=(n,c2,z)=>{x.fillStyle=c2;for(let i=0;i<n;i++)x.fillRect(rn()*30|0,rn()*30|0,z,z)};
 if(t===0)dots(14,'#3a5a35',2);if(t===6)dots(16,'#7a5a3c',2);if(t===5){dots(10,'#4a4a52',2);x.fillStyle='#4a4a52';x.fillRect(0,31,32,1)}
 if(t===1){x.fillStyle='#00000033';for(let y=0;y<32;y+=8)x.fillRect(0,y,32,1);x.fillRect(10,0,1,8);x.fillRect(22,8,1,8);x.fillRect(6,16,1,8);x.fillRect(18,24,1,8)}
 if(t===2){x.fillStyle='#00000055';for(let y=0;y<32;y+=8){x.fillRect(0,y,32,1);for(let q=(y/8%2)*8;q<32;q+=16)x.fillRect(q,y,1,8)}x.fillStyle='#ffffff18';x.fillRect(0,0,32,3)}
 if(t===3){x.fillStyle='#2f5f8a';for(let i=0;i<5;i++)x.fillRect(rn()*24|0,rn()*30|0,8,1)}
 if(t===4){x.strokeStyle='#8a1a22';x.lineWidth=2;x.beginPath();x.arc(16,16,11,0,7);x.stroke();dots(5,'#8a1a22',3)}
 if(t===8)dots(18,'#b89e62',2);
 if(t===9){dots(10,'#c4d0de',3);dots(8,'#fff',2)}
 if(t===10){x.fillStyle='#00000040';for(let y=0;y<32;y+=8){x.fillRect(0,y,32,1);for(let q=(y/8%2)*5;q<32;q+=10)x.fillRect(q,y,1,8)}}
 if(t===11)dots(24,'#383840',1);
 if(t===12){dots(14,'#383840',1);x.fillStyle='#d4b020';x.fillRect(0,14,10,4);x.fillRect(16,14,10,4)}
 if(t===13){x.fillStyle='#2a2a30';x.fillRect(0,0,16,16);x.fillRect(16,16,16,16)}
 if(t===14){x.strokeStyle='#c8a040';x.lineWidth=2;x.strokeRect(3,3,26,26);dots(8,'#8a2030',2)}
 if(t===15){dots(14,'#2a2214',3);dots(8,'#4a5a2a',2)}
 if(t===16){dots(10,'#ffb020',4);dots(10,'#ffe060',2)}
 if(t===17){x.fillStyle='#00000055';for(let y=0;y<32;y+=8){x.fillRect(0,y,32,1);for(let q=(y/8%2)*8;q<32;q+=16)x.fillRect(q,y,1,8)}x.fillStyle='#ffffff14';x.fillRect(0,0,32,2)}
 if(t===18){x.fillStyle='#3f7a3a';for(let i=0;i<14;i++){const a=rn()*30|0,b=rn()*26|0;x.fillRect(a,b,1,5);x.fillRect(a+1,b+1,1,3)}}
 if(t===19){dots(10,'#b0661c',3);dots(8,'#8a3a14',2);dots(5,'#caa040',2)}
 if(t===20){dots(14,'#5a5650',2);dots(10,'#9a968e',2)}
 if(t===21){x.strokeStyle='#e8f6ff';x.lineWidth=1;for(let i=0;i<4;i++){x.beginPath();x.moveTo(rn()*32,rn()*32);x.lineTo(rn()*32,rn()*32);x.stroke()}}
 if(t===22){x.fillStyle='#00000033';for(let y=0;y<32;y+=8)x.fillRect(0,y,32,1);x.fillStyle='#7a0d14';x.beginPath();x.ellipse(14,16,9,6,.4,0,7);x.fill();x.fillStyle='#9a1420';x.fillRect(10,13,3,2)}
 if(t===23)dots(30,'#555566',1);
 if(t===24){x.strokeStyle='#a8b4ba';x.lineWidth=1;x.strokeRect(.5,.5,31,31);x.beginPath();x.moveTo(16,0);x.lineTo(16,32);x.moveTo(0,16);x.lineTo(32,16);x.stroke()}
 if(t===25){x.strokeStyle='#16161c';x.lineWidth=1;x.strokeRect(.5,.5,31,31);x.beginPath();x.moveTo(6,0);x.lineTo(11,13);x.lineTo(8,24);x.stroke();dots(6,'#3a3a46',2)}
 if(t===26){x.fillStyle='#00000044';for(let q=0;q<32;q+=8)x.fillRect(q,0,1,32);x.fillStyle='#ffffff14';x.fillRect(0,0,32,3)}
 if(t===27){x.fillStyle='#6ab0cc';for(let i=0;i<5;i++)x.fillRect(rn()*24|0,rn()*30|0,8,1)}
 if(t===28){x.fillStyle='#00000044';for(let q=0;q<32;q+=8)x.fillRect(q,0,1,32);x.fillStyle='#00000066';x.fillRect(0,0,32,2);x.fillRect(0,30,32,2)}
 if(t===29){x.fillStyle='#3f2814';for(let y=2;y<32;y+=6)x.fillRect(0,y,32,2)}
 if(t===30){x.fillStyle='#00000055';x.fillRect(0,10,32,1);x.fillRect(0,21,32,1);x.fillRect(11,0,1,10);x.fillRect(22,11,1,10);x.fillRect(8,22,1,10);x.fillStyle='#ffffff1a';x.fillRect(0,0,32,3)}
 if(t===31){x.fillStyle='#00000026';for(let y=0;y<32;y+=16)x.fillRect(0,y,32,1);dots(10,'#a89878',2);x.fillStyle='#ffffff22';x.fillRect(0,0,32,3)}
 return c});
// ---------- estado ----------
const sock=io();
let me={},map=null,ps=[],os=[],fx=[],lib=[],MP=[],tool='hand',tile=2,pick=null,sel=null,jr=[],at={},mspr='investigador',cam={x:640,y:448},down=new Set(),jx=0,jy=0,last='',dl=null,Z=1,disp={},ro={names:[],playing:false},lc=-1,drag=null,rs=null,re=null,st=[],stId=null,gopen=new Set();
$('nm').value=localStorage.pn||'';
sock.on('connect',()=>{const s=sessionStorage.po;if(s)sock.emit('room:rejoin',JSON.parse(s),ready)});
function ready(r){
 if(r.err){sessionStorage.removeItem('po');$('err').textContent=r.err;$('home').hidden=false;$('game').hidden=true;me={};return}
 me=r;sessionStorage.po=JSON.stringify({code:r.code,pid:r.pid});
 $('home').hidden=true;$('game').hidden=false;$('code').textContent=$('code2').textContent=r.code;
 const m=r.role==='m';$('mp').hidden=!m;$('mt').hidden=!m;layout();if(m){setTool('hand');insp()}}
function layout(){$('touch').hidden=!(map&&me.role==='p');$('wait').hidden=me.role==='m'||!!map;$('hpb').hidden=me.role!=='p'}
$('bc').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:create',{},ready)};
$('bj').onclick=()=>{localStorage.pn=$('nm').value;sock.emit('room:join',{code:$('cd').value,name:$('nm').value},ready)};
$('mt').onclick=()=>$('mp').classList.toggle('c');
$('bjr').onclick=()=>{$('jr').hidden=!$('jr').hidden};
sock.on('map',m=>{if(!map||map.id!==m.id){os=[];ps=[]}if(stId!==m.id){st=[];stId=null}map=m;$('mn').textContent=m.name;$('mnm').value=m.name;$('mw').value=m.w;$('mh').value=m.h;disp={};layout()});
sock.on('tiles',d=>{if(map&&map.id===d.id)d.c.forEach(t=>map.tiles[t[1]*map.w+t[0]]=t[2])});
sock.on('maps',d=>{MP=d.list;$('maps').innerHTML=OPT(d.list.map(m=>[m.id,m.name+(m.id===d.start?' 🏁':'')]),d.view)});
sock.on('tick',d=>{ps=d.ps;if(d.st){st=d.st;stId=d.sid}os=(map&&stId===map.id?st:[]).concat(d.os);const m=ps.find(p=>p.id===me.pid);if(m)$('hpf').style.width=100*m.hp/m.maxhp+'%'});
sock.on('stop',()=>{map=null;os=[];ps=[];st=[];stId=null;dl=null;$('dlg').hidden=true;layout()});
sock.on('lib',l=>{lib=l;gal()});
sock.on('roster',r=>{ro=r;const t=r.names.length?'Jogadores: '+r.names.join(', '):'Nenhum jogador ainda.';$('ros').textContent=$('ros2').textContent=t;$('go').textContent=r.playing?'■ Encerrar sessão':'▶ Iniciar sessão'});
sock.on('me',m=>{at=m.at;mspr=m.spr;showAt()});
sock.on('dialog',d=>{dl={d:d,i:0};showDl()});
sock.on('journal',j=>{jr=j;$('jr').innerHTML='<b>Diário de investigação</b>'+(j.length?j.map(x=>'<p><b>'+esc(x.t)+'</b><br>'+esc(x.x)+'</p>').join(''):'<p><small>Nenhuma pista descoberta.</small></p>')});
let tt;function toast(t){const e=$('toast');e.textContent=t;e.style.opacity=1;clearTimeout(tt);tt=setTimeout(()=>e.style.opacity=0,3500)}
sock.on('toast',toast);
sock.on('fx',f=>{f.t0=performance.now();fx.push(f)});
function showAt(){const sum=Object.keys(at).reduce((a,k)=>a+at[k],0);
 $('sps').innerHTML=PS.map(k=>'<button data-s="'+k+'"'+(k===mspr?' class="on"':'')+' title="'+SPR[k].n+'"><img src="'+url(k)+'"></button>').join('');
 $('atb').innerHTML=['FOR','AGI','INT','PRE','VIG'].map(k=>'<div><b>'+k+'</b><button data-a="'+k+'" data-d="-1">−</button> '+at[k]+' <button data-a="'+k+'" data-d="1">+</button></div>').join('')+'<small>Pontos restantes: '+(10-sum)+'</small>';
 $('der').textContent='Vida '+(12+at.VIG*4)+' · Dano '+(2+at.FOR*2)+' · Velocidade '+(90+at.AGI*14)+' · INT e PRE são narrativos por enquanto'}
$('sps').onclick=e=>{const b=e.target.closest('button');if(b)sock.emit('look',{spr:b.dataset.s})};
$('atb').onclick=e=>{const k=e.target.dataset.a;if(!k)return;const n=Object.assign({},at);n[k]+=+e.target.dataset.d;if(n[k]<0||n[k]>5||Object.keys(n).reduce((a,x)=>a+n[x],0)>10)return;sock.emit('attrs',n)};
function showDl(){if(!dl)return;$('dlg').hidden=false;$('dlg').innerHTML='<img src="'+url(dl.d.spr)+'"><b>'+esc(dl.d.name)+'</b><p>'+esc(dl.d.lines[dl.i])+'</p><button id="dn">'+(dl.i<dl.d.lines.length-1?'Próxima ▸':'Fechar')+'</button>';$('dn').onclick=nextDl}
function nextDl(){if(!dl)return;if(++dl.i>=dl.d.lines.length){dl=null;$('dlg').hidden=true}else showDl()}
function attack(a){if(me.role==='p'&&map)sock.emit('attack',{a:a})}
function interact(){if(dl)nextDl();else if(me.role==='p'&&map)sock.emit('interact')}
$('bA').onpointerdown=e=>{e.stopPropagation();attack()};$('bE').onpointerdown=e=>{e.stopPropagation();interact()};
addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;const k=e.key.toLowerCase();down.add(k);
 if(k===' '){attack();e.preventDefault()}if(k==='e')interact();if(k.startsWith('arrow'))e.preventDefault()});
addEventListener('keyup',e=>down.delete(e.key.toLowerCase()));
const ax=(a,b)=>(down.has(a[0])||down.has(a[1])?1:0)-(down.has(b[0])||down.has(b[1])?1:0);
setInterval(()=>{if(me.role!=='p'||!map)return;const kx=ax(['d','arrowright'],['a','arrowleft']),ky=ax(['s','arrowdown'],['w','arrowup']);
 const x=kx||jx,y=ky||jy,s=x.toFixed(2)+','+y.toFixed(2);if(s!==last){last=s;sock.emit('input',{x:x,y:y})}},50);
(()=>{const j=$('joy'),k=$('knob');let id=null;
 const mv=e=>{const r=j.getBoundingClientRect();let dx=e.clientX-(r.left+60),dy=e.clientY-(r.top+60);const l=Math.hypot(dx,dy),m=48;if(l>m){dx*=m/l;dy*=m/l}
  jx=dx/m;jy=dy/m;k.style.transform='translate('+dx+'px,'+dy+'px)'};
 j.onpointerdown=e=>{id=e.pointerId;j.setPointerCapture(id);mv(e)};j.onpointermove=e=>{if(e.pointerId===id)mv(e)};
 j.onpointerup=j.onpointercancel=()=>{id=null;jx=jy=0;k.style.transform=''}})();
// ---------- editor de mapas ----------
function setTool(t){tool=t;document.querySelectorAll('#tools button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
 $('tiles').hidden=!['paint','fill','rect'].includes(t);$('gal').hidden=t!=='place';gal()}
$('tools').onclick=e=>{const b=e.target.closest('button');if(b)setTool(b.dataset.t)};
$('tiles').innerHTML=TI.map((c,i)=>'<button data-i="'+i+'" title="'+TN[i]+'" style="background-image:url('+c.toDataURL()+')"></button>').join('');
$('tiles').onclick=e=>{const b=e.target.closest('button');if(b){tile=+b.dataset.i;document.querySelectorAll('#tiles button').forEach(x=>x.classList.toggle('on',x===b))}};
const KL=[['enemy','Inimigos'],['npc','NPCs'],['prop','Cenário'],['clue','Pistas'],['door','Portas e construções entráveis'],['event','Eventos'],['spawn','Início dos jogadores']];
const gkey=l=>l.kind==='prop'?((SPR[l.spr]||{}).cat||'Cenário'):(KL.find(g=>g[0]===l.kind)||[])[1]||l.kind;
function gal(){if(!lib.length)return;if(!lib.find(l=>l.id===pick))pick=lib[0].id;const pl=lib.find(l=>l.id===pick),q=$('gq').value.trim().toLowerCase(),G={};
 KL.forEach(g=>lib.filter(l=>l.kind===g[0]&&(!q||l.name.toLowerCase().includes(q))).forEach(l=>(G[gkey(l)]=G[gkey(l)]||[]).push(l)));
 $('gsel').innerHTML='<img class="pv" src="'+url(pl.spr)+'"><b>'+esc(pl.name)+'</b> <small>'+pl.kind+'</small>';
 $('gl').innerHTML=Object.keys(G).map(k=>'<details data-k="'+esc(k)+'"'+(q||gopen.has(k)||G[k].some(l=>l.id===pick)?' open':'')+'><summary>'+esc(k)+' <small>'+G[k].length+'</small></summary><div class="g">'+G[k].map(l=>'<button data-l="'+esc(l.id)+'" title="'+esc(l.name)+'"'+(l.id===pick?' class="on"':'')+'><img src="'+url(l.spr)+'"></button>').join('')+'</div></details>').join('')||'<small>Nada encontrado.</small>'}
$('gq').oninput=gal;
$('gl').addEventListener('toggle',e=>{const d=e.target;if(d.dataset&&d.dataset.k){if(d.open)gopen.add(d.dataset.k);else gopen.delete(d.dataset.k)}},true);
$('gal').onclick=e=>{const b=e.target.closest('button');if(b){pick=b.dataset.l;gal()}};
$('maps').onchange=e=>{sel=null;insp();sock.emit('map:view',{id:e.target.value})};
$('bmg').onclick=()=>{$('mform').hidden=!$('mform').hidden};
$('bst').onclick=()=>sock.emit('map:start',{});
$('mnew').onclick=()=>sock.emit('map:new',{name:$('mnm').value,w:+$('mw').value,h:+$('mh').value,tpl:$('mtpl').value});
$('msave').onclick=()=>sock.emit('map:edit',{name:$('mnm').value,w:+$('mw').value,h:+$('mh').value});
$('mdel').onclick=()=>{if(confirm('Excluir este mapa e tudo o que há nele?'))sock.emit('map:del',{})};
function bbox(o){const s=SPR[o.spr]||SPR.caixa,w=s.tw*16,h=s.th*32;return s.flat?[o.x-w,o.y-h/2,o.x+w,o.y+h/2]:[o.x-w,o.y+10-h,o.x+w,o.y+10]}
const near=(p,r)=>{let b=null,ba=1e9;for(const o of os){const q=bbox(o);if(p.x>=q[0]&&p.x<=q[2]&&p.y>=q[1]&&p.y<=q[3]){const a=(q[2]-q[0])*(q[3]-q[1])*((SPR[o.spr]||{}).flat?3:1);if(a<ba){ba=a;b=o}}}
 if(b)return b;let bd=r;for(const o of os){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<bd){bd=d;b=o}}return b};
const cellOf=p=>({x:Math.floor(p.x/TS),y:Math.floor(p.y/TS)});
function act(p){const c=cellOf(p);if(!map||c.x<0||c.y<0||c.x>=map.w||c.y>=map.h)return;
 if(tool==='paint'){const k=c.y*map.w+c.x;if(k===lc)return;lc=k;sock.emit('map:paint',{x:c.x,y:c.y,t:tile})}
 else if(tool==='fill')sock.emit('map:fill',{x:c.x,y:c.y,t:tile});
 else if(tool==='place'){const t=lib.find(l=>l.id===pick);if(!t)return;const o=JSON.parse(JSON.stringify(t));delete o.id;o.x=(c.x+.5)*TS;o.y=(c.y+.5)*TS;sock.emit('obj:put',{obj:o})}
 else if(tool==='del'){const o=near(p,22);if(o){sock.emit('obj:del',o.id);if(sel===o.id){sel=null;insp()}}}
 else if(tool==='sel'){const o=near(p,22);sel=o?o.id:null;insp()}}
const cv=$('cv'),wp=e=>({x:(e.clientX-innerWidth/2)/Z+cam.x,y:(e.clientY-innerHeight/2)/Z+cam.y});
cv.onpointerdown=e=>{if(!map)return;cv.setPointerCapture(e.pointerId);
 if(me.role==='p'){attack(Math.atan2(e.clientY-innerHeight/2,e.clientX-innerWidth/2));return}
 drag={x:e.clientX,y:e.clientY};lc=-1;const p=wp(e);if(tool==='rect'){rs=re=cellOf(p)}else act(p)};
cv.onpointermove=e=>{if(me.role!=='m'||!map)return;const p=wp(e),c=cellOf(p);$('cell').textContent='x'+c.x+' y'+c.y;if(!drag)return;
 if(tool==='hand'){cam.x-=(e.clientX-drag.x)/Z;cam.y-=(e.clientY-drag.y)/Z;drag.x=e.clientX;drag.y=e.clientY}else if(tool==='paint')act(p);else if(tool==='rect')re=c};
cv.onpointerup=()=>{if(tool==='rect'&&rs&&drag)sock.emit('map:rect',{x0:rs.x,y0:rs.y,x1:re.x,y1:re.y,t:tile});rs=re=null;drag=null};
// ---------- inspetor de objetos e editor de eventos ----------
const AN={say:'Mensagem na tela',dialog:'Diálogo',spawn:'Gerar inimigos (encontro)',tp:'Teleportar jogadores',show:'Mostrar/esconder objeto',lock:'Trancar/destrancar porta',heal:'Curar jogadores',hurt:'Causar dano',clue:'Adicionar pista ao diário'};
const F={say:[['text','Texto','t']],dialog:[['name','Quem fala','t'],['spr','Sprite','S'],['lines','Falas (uma por linha)','a']],spawn:[['lib','Inimigo','E'],['count','Quantidade','n']],
 tp:[['map','Mapa','M'],['x','X (célula, -1 = início)','n'],['y','Y (célula)','n']],show:[['target','Objeto','O'],['v','Ação','V']],lock:[['target','Porta','D'],['v','Ação','L']],heal:[],hurt:[['v','Dano','n']],clue:[['name','Título','t'],['text','Texto','A']]};
const AD={dialog:{lines:[]},spawn:{count:2,lib:'zumbi'},tp:{x:-1,y:-1},show:{v:true},lock:{v:false},hurt:{v:3}};
function acRow(a){return '<div class="ac" data-t="'+a.t+'"><button class="rm">✕</button><b>'+AN[a.t]+'</b>'+(F[a.t]||[]).map(f=>{const n=f[0],ty=f[2],v=a[n];let i;
 if(ty==='a'||ty==='A')i='<textarea data-f="'+n+'">'+esc(Array.isArray(v)?v.join('\n'):v)+'</textarea>';
 else if(ty==='n')i='<input data-f="'+n+'" type="number" value="'+(v==null?0:v)+'">';
 else if(ty==='t')i='<input data-f="'+n+'" value="'+esc(v)+'">';
 else{let h;if(ty==='S')h=selOpt(SOPT,v||'aldeao');else if(ty==='E')h=OPT(lib.filter(l=>l.kind==='enemy').map(l=>[l.id,l.name]),v);
  else if(ty==='M')h=OPT(MP.map(m=>[m.id,m.name]),v);else if(ty==='O')h=OPT(os.filter(o=>o.kind!=='spawn').map(o=>[o.id,o.name+' ('+o.kind+')']),v);
  else if(ty==='D')h=OPT(os.filter(o=>o.kind==='door').map(o=>[o.id,o.name]),v);else if(ty==='V')h=OPT([['1','Mostrar'],['0','Esconder']],v?'1':'0');else h=OPT([['1','Trancar'],['0','Destrancar']],v?'1':'0');
  i='<select data-f="'+n+'">'+h+'</select>'}
 return '<label>'+f[1]+i+'</label>'}).join('')+'</div>'}
function insp(){const el=$('insp'),o=os.find(x=>x.id===sel);
 if(!o){el.innerHTML='<small>Use ✏️ e toque num objeto, porta ou evento para editar.</small>';return}
 const k=o.kind,L=(n,l,t,v)=>'<label>'+l+(t==='a'?'<textarea data-k="'+n+'">'+esc(v)+'</textarea>':'<input data-k="'+n+'" type="'+(t==='c'?'checkbox':t==='n'?'number':'text')+'" '+(t==='c'?(v?'checked':''):'value="'+esc(v)+'"')+'>')+'</label>';
 let h='<b>'+esc(o.name||k)+'</b> <small>'+k+'</small>'+L('name','Nome','t',o.name)+'<label>Sprite<select data-k="spr">'+selOpt(SOPT,o.spr)+'</select></label>';
 if(k==='npc')h+=L('dialog','Falas (uma por linha)','a',(o.dialog||[]).join('\n'));
 if(k==='enemy')h+=L('hp','Vida','n',o.maxhp)+L('atk','Ataque','n',o.atk)+L('spd','Velocidade','n',o.spd);
 if(k==='prop'||k==='door')h+=L('solid','Bloqueia passagem','c',o.solid)+L('fw','Colisão: largura (células)','n',o.fw||1)+L('fh','Colisão: altura (células)','n',o.fh||1);
 if(k==='clue')h+=L('text','Informação (revelada ao examinar)','a',o.text);
 if(k==='door')h+='<label>Leva ao mapa<select data-k="to"><option value="">— nenhum —</option>'+OPT(MP.map(m=>[m.id,m.name]),o.to)+'</select></label>'+L('tx','Destino X (célula, -1 = início do mapa)','n',o.tx)+L('ty','Destino Y (célula)','n',o.ty)+L('group','Leva o grupo todo','c',o.group)+L('locked','Trancada','c',o.locked)+L('back','Criar porta de volta no destino','c',false);
 if(k==='event')h+='<label>Quando<select data-k="when">'+OPT([['enter','Jogador entra na área'],['interact','Jogador interage (E)'],['clear','Todos os inimigos do mapa morrem']],o.when)+'</select></label>'+L('r','Raio da área (px)','n',o.r)+L('once','Acontece uma vez só','c',o.once)+L('reset','Reativar agora','c',false)+'<b>Ações</b><div id="acs">'+(o.acts||[]).map(acRow).join('')+'</div><div style="display:flex;gap:6px;margin-top:6px"><select id="addt" style="flex:1">'+OPT(Object.keys(AN).map(t=>[t,AN[t]]),'say')+'</select><button id="addb">+ Ação</button></div>';
 if(k!=='spawn')h+=L('vis','Visível aos jogadores','c',!o.hidden);
 h+=L('note','Notas secretas (só o mestre vê)','a',o.note)+'<div style="display:flex;gap:6px;margin-top:6px"><button id="ap" style="flex:1">Aplicar</button><button id="sv" title="Guardar na biblioteca">Salvar modelo</button>'+(k==='door'?'<button id="gd">Ver destino</button>':'')+'</div>';
 el.innerHTML=h;
 if(k==='event'){$('addb').onclick=()=>{const t=$('addt').value;$('acs').insertAdjacentHTML('beforeend',acRow(Object.assign({t:t},AD[t]||{})))};$('acs').onclick=e=>{if(e.target.className==='rm')e.target.parentNode.remove()}}
 const get=()=>{const r={id:o.id};el.querySelectorAll('[data-k]').forEach(i=>{const n=i.dataset.k;let v=i.type==='checkbox'?i.checked:i.type==='number'?+i.value:i.value;
   if(n==='dialog')v=v.split(/\r?\n/);if(n==='vis')r.hidden=!v;else r[n]=v});
  if(k==='event')r.acts=[...el.querySelectorAll('.ac')].map(w=>{const a={t:w.dataset.t};w.querySelectorAll('[data-f]').forEach(i=>{const n=i.dataset.f,ty=(F[a.t].find(f=>f[0]===n)||[])[2];
    a[n]=ty==='n'?+i.value:ty==='a'?i.value.split(/\r?\n/):(ty==='V'||ty==='L')?i.value==='1':i.value});return a});return r};
 $('ap').onclick=()=>{sock.emit('obj:put',{obj:get()});toast('Aplicado')};
 $('sv').onclick=()=>{const r=get();r.kind=k;sock.emit('lib:save',{obj:r});toast('Modelo salvo na biblioteca (aba ➕)')};
 if(k==='door')$('gd').onclick=()=>{if(o.to){sel=null;sock.emit('map:view',{id:o.to});insp()}}}
$('go').onclick=()=>sock.emit(ro.playing?'game:stop':'game:start');
$('heal').onclick=()=>sock.emit('heal');
$('diff').onchange=e=>sock.emit('diff',+e.target.value);
$('bsay').onclick=()=>{sock.emit('say',$('say').value);$('say').value=''};
$('exp').onclick=()=>sock.emit('camp:export',j=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([j],{type:'application/json'}));a.download='campanha.json';a.click()});
$('imp').onclick=()=>$('file').click();
$('file').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>sock.emit('camp:import',r.result,x=>{toast(x.err||'Campanha importada');sel=null;insp()});r.readAsText(f);e.target.value=''};
// ---------- renderização ----------
function sm(id,x,y){const d=disp[id]||(disp[id]={x:x,y:y,f:1,mv:0});const dx=x-d.x,dy=y-d.y;if(Math.abs(dx)+Math.abs(dy)>120){d.x=x;d.y=y}else{d.x+=dx*.35;d.y+=dy*.35}d.mv=Math.hypot(dx,dy)>.8;if(Math.abs(dx)>.5)d.f=dx<0?-1:1;return d}
function bar(c,x,y,w,f,col){c.fillStyle='#000a';c.fillRect(x-w/2,y,w,4);c.fillStyle=col;c.fillRect(x-w/2,y,w*Math.max(0,f),4)}
function sprite(c,id,x,y,f,bob){const s=SPR[id]||SPR.caixa;c.save();c.translate(x,y+bob);if(f<0)c.scale(-1,1);c.drawImage(s.img,-s.tw*16,s.flat?-s.th*16:10-s.th*32);c.restore()}
function shadow(c,x,y){c.fillStyle='#0006';c.beginPath();c.ellipse(x,y+9,10,4,0,0,7);c.fill()}
function draw(){requestAnimationFrame(draw);if($('game').hidden)return;
 const w=cv.width=innerWidth,h=cv.height=innerHeight,c=cv.getContext('2d'),now=performance.now();c.imageSmoothingEnabled=false;c.fillStyle='#000';c.fillRect(0,0,w,h);if(!map)return;
 Z=Math.max(.9,Math.min(1.6,w/560));const M=me.role==='m',mine=ps.find(p=>p.id===me.pid);
 if(mine){const d=sm(mine.id,mine.x,mine.y);cam.x=d.x;cam.y=d.y}else if(M&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){cam.x+=ax(['d','arrowright'],['a','arrowleft'])*8;cam.y+=ax(['s','arrowdown'],['w','arrowup'])*8}
 c.save();c.translate(w/2,h/2);c.scale(Z,Z);c.translate(-cam.x,-cam.y);
 const x0=Math.max(0,Math.floor((cam.x-w/2/Z)/TS)),x1=Math.min(map.w-1,Math.ceil((cam.x+w/2/Z)/TS)),y0=Math.max(0,Math.floor((cam.y-h/2/Z)/TS)),y1=Math.min(map.h-1,Math.ceil((cam.y+h/2/Z)/TS));
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){c.drawImage(TI[map.tiles[y*map.w+x]],x*TS,y*TS);if(M){c.strokeStyle='#ffffff0d';c.strokeRect(x*TS,y*TS,TS,TS)}}
 if(rs&&re){const a=Math.min(rs.x,re.x),b=Math.min(rs.y,re.y),e=Math.abs(rs.x-re.x)+1,g=Math.abs(rs.y-re.y)+1;c.fillStyle='#ffffff33';c.fillRect(a*TS,b*TS,e*TS,g*TS)}
 c.textAlign='center';c.textBaseline='middle';
 const fl=i=>(SPR[i.o.spr]||{}).flat?0:1;
 const items=os.map(o=>({o:o,d:sm(o.id,o.x,o.y)})).sort((a,b)=>fl(a)-fl(b)||a.d.y-b.d.y);
 for(const it of items){const o=it.o,d=it.d,hid=o.hidden||o.kind==='spawn';c.globalAlpha=hid?.5:1;
  if(M&&o.kind==='event'&&o.when==='enter'){c.setLineDash([5,5]);c.strokeStyle='#ff6';c.beginPath();c.arc(d.x,d.y,o.r,0,7);c.stroke();c.setLineDash([])}
  const mover=o.kind==='enemy',flat=(SPR[o.spr]||{}).flat;if(mover||o.kind==='npc')shadow(c,d.x,d.y);
  sprite(c,o.spr,d.x,d.y,mover?d.f:1,mover&&d.mv?Math.sin(now/70)*1.5:0);c.globalAlpha=1;
  if(o.id===sel){const q=bbox(o);c.strokeStyle='#fff';c.strokeRect(q[0],q[1],q[2]-q[0],q[3]-q[1])}
  if(o.kind==='enemy'&&(o.hp<o.maxhp||M))bar(c,d.x,d.y-24,28,o.hp/o.maxhp,'#d23a4c');
  if(['npc','enemy','door'].includes(o.kind)||(M&&o.kind!=='prop')){c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(o.name,d.x,d.y+16)}}
 for(const p of ps){const d=disp[p.id]||sm(p.id,p.x,p.y);if(p.id!==me.pid)sm(p.id,p.x,p.y);
  if(p.dead){c.font='22px serif';c.fillText('💀',d.x,d.y);continue}
  shadow(c,d.x,d.y);c.strokeStyle=p.color;c.lineWidth=2;c.beginPath();c.ellipse(d.x,d.y+9,12,5,0,0,7);c.stroke();
  sprite(c,p.spr,d.x,d.y,d.f,d.mv?Math.sin(now/60)*1.5:0);
  bar(c,d.x,d.y-24,26,p.hp/p.maxhp,'#4c4');c.font='10px sans-serif';c.fillStyle='#fff';c.fillText(p.name,d.x,d.y+18)}
 fx=fx.filter(f=>now-f.t0<700);
 for(const f of fx){const a=(now-f.t0)/700;
  if(f.t==='slash'){c.strokeStyle='rgba(255,255,255,'+(1-a*1.5)+')';c.lineWidth=3;c.beginPath();c.arc(f.x,f.y,18,f.a-1,f.a+1);c.stroke()}
  else{c.globalAlpha=1-a;c.font='bold 16px sans-serif';c.fillStyle=f.c;c.fillText(f.v,f.x,f.y-14-a*24);c.globalAlpha=1}}
 c.globalCompositeOperation='lighter';
 for(const it of items){const s=SPR[it.o.spr];if(!s||!s.gl||it.o.hidden||Math.abs(it.d.x-cam.x)>w/2/Z+90||Math.abs(it.d.y-cam.y)>h/2/Z+90)continue;
  const fk=.8+.2*Math.sin(now/130+it.o.x),gy=it.d.y-6-(s.th>1?8:0),g2=c.createRadialGradient(it.d.x,gy,2,it.d.x,gy,76);g2.addColorStop(0,'rgba('+s.gl+','+(.3*fk)+')');g2.addColorStop(1,'rgba('+s.gl+',0)');c.fillStyle=g2;c.beginPath();c.arc(it.d.x,gy,76,0,7);c.fill()}
 c.globalCompositeOperation='source-over';
 c.restore();
 if(me.role==='p'){const g=c.createRadialGradient(w/2,h/2,Math.min(w,h)*.25,w/2,h/2,Math.max(w,h)*.7);g.addColorStop(0,'#0000');g.addColorStop(1,'#000c');c.fillStyle=g;c.fillRect(0,0,w,h)}}
draw();
</script></body></html>`; }
