# Anvil distilled rules

_General hardware-selection rules learned across runs._

- Tight power budget: pick the lowest-power compute module that still clears the TOPS workload, not the most capable one.
- Size regulator rail current to the summed PEAK draw on each rail, not the average.
- Long-runtime targets: size the battery from avg_power x required_hours up front, with margin.
- Mass-constrained builds: the battery dominates mass -- size it last against remaining budget.
- Pick the enclosure from the summed board footprint, not the smallest available shell.
- Verify camera CSI lane count against host SoM lanes, not just resolution/fps.
