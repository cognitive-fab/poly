import { writeFileSync } from 'node:fs';
const K = Number(process.argv[2]), R = Number(process.argv[3] ?? 3);
const idx = [...Array(K).keys()].map(i => i + 1);
let s = `module p2k${K}

type ObsState = Empty | Pending | Full | Handled | Released
type ArchState = Free | Held | Gone

machine Archive {
  state { st : ArchState = Free  refs : 0..2 = 0 }
  terminal st is Gone
  action Store(from: Ref<Observation>)
  action Drop()
  on Store(from) {
    require st is Free else reject "not-free"
    st' = Held
    refs' = 1
    send from <- Stored()
  }
  on Drop {
    require st is Held else reject "not-held"
    st' = Gone
    refs' = 0
  }
}

machine Observation {
  state { st : ObsState = Empty  sent : 0..3 = 0  arch : Ref<Archive> = none }
  terminal st is Released
  action Put()
  action Stored()
  action Sent()
  action Release()
  on Put { require st is Empty else reject "not-empty"  st' = Pending  send arch <- Store(from: self) }
  on Stored { require st is Pending else reject "not-pending"  st' = Full }
  on Sent {
    require st is Full else reject "not-full"
    sent' = sent + 1
    if sent + 1 >= 3 { st' = Handled }
  }
  on Release { require st is Handled else reject "not-handled"  st' = Released  send arch <- Drop() }
}

machine Session {
  state { requests : 0..${R} = 0 ${idx.map(i => `o${i} : Ref<Observation> = none`).join('  ')} }
  terminal requests in { ${R} }
  action Req()
  on Req {
    require requests < ${R} else reject "cap"
    requests' = requests + 1
${idx.map(i => `    send o${i} <- Sent()`).join('\n')}
  }
}

configuration pack {
  ${idx.map(i => `a${i} : Archive`).join('\n  ')}
  ${idx.map(i => `o${i} : Observation { arch: a${i} }`).join('\n  ')}
  s : Session { ${idx.map(i => `o${i}: o${i}`).join(', ')} }
  inputs { s.Req, ${idx.map(i => `o${i}.Put`).join(', ')}, ${idx.map(i => `o${i}.Release`).join(', ')} }
  bounds { transit ${K * R + 2} }
${idx.map(i => `  invariant handled-resolves-${i}: o${i} is Handled implies a${i} is Held
  invariant twice-then-handle-${i}: (o${i} is Handled implies o${i}.sent == 3) && (o${i} is Full implies o${i}.sent <= 2)`).join('\n')}
}
`;
writeFileSync(new URL(`./p2k${K}.poly`, import.meta.url), s);
