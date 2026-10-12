export function calibrationScenarios(seed) {
  return [
    {id:'reference',negative:false},
    ...(seed.execution.alternativeReferences ?? []).map((r,i)=>({id:`alternative-${i+1}`,negative:false,override:r})),
    ...seed.negative_cases.map((n,i)=>({id:`negative-${i+1}`,negative:true,override:n.override})),
  ];
}
