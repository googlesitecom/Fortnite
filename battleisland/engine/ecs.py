"""
ecs.py — Entity Component System propio del motor.

Diseño: almacenamiento tipo "sparse set" por componente. Las entidades son
enteros; cada tipo de componente tiene su propio mapa entidad->dato. Los
sistemas se registran con un filtro de componentes y corren en orden.

Es deliberadamente simple pero real: create/destroy, add/get/remove,
query(componentes) devuelve listas de ids + arrays de datos, eventos globales.
"""
from collections import defaultdict


class World:
    def __init__(self):
        self._next_id = 1
        self._alive = set()
        # comp_type name -> {entity_id: data}
        self._stores = {}
        self._systems = []
        self._events = defaultdict(list)

    # ------------------------------------------------------------ Entidades
    def create_entity(self):
        eid = self._next_id
        self._next_id += 1
        self._alive.add(eid)
        return eid

    def destroy_entity(self, eid):
        self._alive.discard(eid)
        for store in self._stores.values():
            store.pop(eid, None)

    def alive(self, eid):
        return eid in self._alive

    # ----------------------------------------------------------- Componentes
    def _store(self, ctype):
        if ctype not in self._stores:
            self._stores[ctype] = {}
        return self._stores[ctype]

    def add(self, eid, ctype, data=None):
        self._store(ctype)[eid] = data
        return data

    def get(self, eid, ctype, default=None):
        return self._store(ctype).get(eid, default)

    def has(self, eid, ctype):
        return eid in self._store(ctype)

    def remove(self, eid, ctype):
        self._store(ctype).pop(eid, None)

    def query(self, *ctypes):
        """Itera entidades que tienen TODOS los componentes dados."""
        if not ctypes:
            return []
        stores = [self._store(c) for c in ctypes]
        smallest = min(stores, key=len)
        out = []
        for eid in list(smallest.keys()):
            if eid in self._alive and all(s.get(eid) is not None or eid in s for s in stores):
                if all(eid in s for s in stores):
                    out.append((eid, tuple(s[eid] for s in stores)))
        return out

    # -------------------------------------------------------------- Sistemas
    def add_system(self, system, priority=0):
        self._systems.append((priority, system))
        self._systems.sort(key=lambda t: t[0])

    def update(self, dt):
        for _, sys in self._systems:
            sys.update(self, dt)

    # --------------------------------------------------------------- Eventos
    def emit(self, name, payload=None):
        self._events[name].append(payload)

    def drain_events(self, name):
        evs = self._events[name]
        self._events[name] = []
        return evs


class System:
    """Interfaz base: hereda e implementa update(world, dt)."""
    def update(self, world, dt):
        raise NotImplementedError
