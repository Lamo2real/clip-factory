## Add an anchor (so a button can light something up)

Give the control a stable `data-help` attribute, for example `data-help="make-clips"`. Settings apples already carry
their apple id. Then use the id in a guide's `highlight`. The generator fails if a `highlight` names an anchor that
does not exist, and drops a button whose `to` does not match a route.
