from __future__ import annotations

import logging
from functools import lru_cache

LOGGER = logging.getLogger(__name__)


class GeocoderService:
    def __init__(self, user_agent: str = "caixa-imoveis-monitor"):
        self.available = True
        try:
            from geopy.geocoders import Nominatim
        except ImportError:
            LOGGER.warning("geopy nao instalado; geocodificacao desativada.")
            self.available = False
            self.geolocator = None
            return
        self.geolocator = Nominatim(user_agent=user_agent, timeout=10)

    @lru_cache(maxsize=2048)
    def geocode_city_state(self, cidade: str, estado: str) -> tuple[float | None, float | None]:
        if not cidade or not estado:
            return None, None
        if not self.available or self.geolocator is None:
            return None, None

        query = f"{cidade}, {estado}, Brasil"
        try:
            from geopy.exc import GeocoderServiceError, GeocoderTimedOut

            location = self.geolocator.geocode(query)
            if not location:
                return None, None
            return float(location.latitude), float(location.longitude)
        except (GeocoderTimedOut, GeocoderServiceError) as exc:
            LOGGER.warning("Falha no geocode para '%s': %s", query, exc)
            return None, None
