"""telegram_bot._formatting — view builders, render helpers, anchor mechanics.

Split into focused mixins per responsibility; FormattingMixin re-exports
them as a single mixin so service.py keeps inheriting one base class.
The import path ``from ._formatting import FormattingMixin`` keeps
working byte-for-byte.
"""
from ._anchor import _AnchorMixin
from ._cam import _CamMixin
from ._erkennungen import _ErkennungenMixin
from ._root import _RootMixin
from ._status import _StatusMixin
from ._wetter import _WetterMixin


class FormattingMixin(
    _AnchorMixin,
    _RootMixin,
    _StatusMixin,
    _ErkennungenMixin,
    _WetterMixin,
    _CamMixin,
):
    """Aggregate mixin re-exported for service.py. Composition order
    matters only for diamond resolution; current code has no diamonds
    (no two mixins define the same method), so the order is
    alphabetical-ish and stable."""
    pass


__all__ = ["FormattingMixin"]
