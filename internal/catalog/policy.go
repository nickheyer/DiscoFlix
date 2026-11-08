package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/nickheyer/DiscoFlix/internal/catalog/model"
	"github.com/nickheyer/DiscoFlix/internal/store/ent"
	"github.com/nickheyer/DiscoFlix/internal/store/ent/entityfield"
)

// defaultPriority orders sources when their claims disagree, earlier wins
var defaultPriority = []string{SourceUser, SourceTMDB, SourceTVDB, SourceIMDb, SourceTrakt, SourceWikidata, SourceSnapshot, SourceTMDBExport, SourceFanart}

// fieldPriority overrides the order for fields some sources know better
var fieldPriority = map[string][]string{
	model.FieldYear:          {SourceUser, SourceIMDb, SourceTMDB, SourceTVDB, SourceWikidata, SourceSnapshot, SourceTrakt, SourceTMDBExport},
	model.FieldReleaseDate:   {SourceUser, SourceTMDB, SourceIMDb, SourceTVDB, SourceTrakt, SourceWikidata},
	model.FieldOriginalTitle: {SourceUser, SourceTMDB, SourceIMDb, SourceWikidata, SourceTVDB, SourceSnapshot, SourceTMDBExport},
	model.FieldRuntime:       {SourceUser, SourceTMDB, SourceIMDb, SourceTVDB, SourceTrakt, SourceWikidata},
	model.FieldGenres:        {SourceUser, SourceTMDB, SourceTVDB, SourceIMDb, SourceTrakt},
	model.FieldOverview:      {SourceUser, SourceTMDB, SourceTVDB, SourceTrakt},
	model.FieldFirstAirDate:  {SourceUser, SourceTVDB, SourceTMDB, SourceTrakt},
	model.FieldNetworks:      {SourceUser, SourceTVDB, SourceTMDB, SourceTrakt},
	model.FieldStatus:        {SourceUser, SourceTVDB, SourceTMDB, SourceTrakt},
}

// rankOf returns the priority rank of a source for a field, lower wins and unknown sources rank last
func rankOf(field, source string) int32 {
	order := defaultPriority
	if o, ok := fieldPriority[field]; ok {
		order = o
	}
	if strings.HasPrefix(field, model.FieldRatingPrefix) || strings.HasPrefix(field, model.FieldVotesPrefix) {
		if strings.TrimPrefix(strings.TrimPrefix(field, model.FieldRatingPrefix), model.FieldVotesPrefix) == source {
			return 0
		}
	}
	for i, name := range order {
		if name == source {
			return int32(i * 10)
		}
	}
	return 1000
}

// canonical encodes a value as sorted-key JSON so equal values hash equal
func canonical(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return nil, err
	}
	return json.Marshal(generic)
}

// valueHash is the first 32 hex characters of the sha256 of a canonical value
func valueHash(canon []byte) string {
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:16])
}

// decision is the winning claim for one field with the reason it won
type decision struct {
	claim     *ent.Claim
	reason    entityfield.Reason
	agreement int32
	total     int32
}

// decide picks the claim that wins a field, pins first, then source priority, agreement, and recency
func decide(claims []*ent.Claim) (decision, bool) {
	if len(claims) == 0 {
		return decision{}, false
	}
	byValue := map[string][]*ent.Claim{}
	for _, c := range claims {
		byValue[c.ValueHash] = append(byValue[c.ValueHash], c)
	}
	type candidate struct {
		claim     *ent.Claim
		pinned    bool
		rank      int32
		agreement int32
		observed  time.Time
	}
	var cands []candidate
	for _, group := range byValue {
		best := candidate{claim: group[0], rank: group[0].Rank, observed: group[0].ObservedAt}
		sources := map[string]bool{}
		for _, c := range group {
			sources[c.Source] = true
			if c.Pinned {
				best.pinned = true
			}
			if c.Rank < best.rank || (c.Rank == best.rank && c.ObservedAt.After(best.observed)) {
				best.claim, best.rank, best.observed = c, c.Rank, c.ObservedAt
			}
			if c.ObservedAt.After(best.observed) {
				best.observed = c.ObservedAt
			}
		}
		best.agreement = int32(len(sources))
		cands = append(cands, best)
	}
	sort.SliceStable(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		switch {
		case a.pinned != b.pinned:
			return a.pinned
		case a.rank != b.rank:
			return a.rank < b.rank
		case a.agreement != b.agreement:
			return a.agreement > b.agreement
		case !a.observed.Equal(b.observed):
			return a.observed.After(b.observed)
		}
		return a.claim.ValueHash < b.claim.ValueHash
	})
	win := cands[0]
	d := decision{claim: win.claim, agreement: win.agreement, total: int32(len(claims))}
	switch {
	case win.pinned:
		d.reason = entityfield.ReasonPin
	case len(cands) == 1:
		d.reason = entityfield.ReasonOnly
	case win.rank < cands[1].rank:
		d.reason = entityfield.ReasonPriority
	case win.agreement > cands[1].agreement:
		d.reason = entityfield.ReasonAgreement
	default:
		d.reason = entityfield.ReasonRecency
	}
	return d, true
}
